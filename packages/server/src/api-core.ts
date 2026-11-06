import { apiCommands, readM3, writeM3, type M3Callbacks, type M3ReadOp, type M3WriteOp } from './api-m3.js'
import type { WorkflowStore } from '@taktflow/workflow-source'
import { workflowAccess } from './workflow-access.js'
import { readSpace, writeSpace, type SpaceReadOp, type SpaceWriteOp, type LeadMention } from './api-space.js'
import { readWorkflow, writeWorkflow, type WorkflowReadOp, type WorkflowWriteOp } from './api-workflow.js'
import { isUtf8 } from 'node:buffer'
import {
  AttentionStaleError, buildRunGraph, createInsights, loadRunGraph, markArtifactEdited,
  stageProgress, budgetStatus, qualityMetrics, summarizeUsage, withAttentionStaleness, requireRole,
  type Actor, type ArtifactContent, type AttentionItem, type EventEnvelope, type ProjectStores, type RoomMessage,
} from '@taktflow/core'
import type { CatalogCallbacks } from './catalog.js'
import { ApiError } from './errors.js'
import { createEventFeed, type EventFeed, type SequenceSource } from './event-feed.js'
import { nodeDetail, overview, requirement, run, runSummaries, summary, summaries, workflow } from './read-model.js'
import { serialize } from './stale.js'
import { artifactPath, integer, relativePath, safeId, text } from './validation.js'

export { ApiError }

export type ReadOp =
  | 'project' | 'requirements' | 'requirement' | 'artifacts' | 'artifact' | 'comments'
  | 'trace' | 'metrics' | 'runs' | 'run' | 'events' | 'node' | 'audit' | 'attention'
  | 'harnesses' | 'models' | M3ReadOp | SpaceReadOp | WorkflowReadOp

export type WriteOp = 'artifact.edit' | 'comment.add' | 'attention.answer' | M3WriteOp | SpaceWriteOp | WorkflowWriteOp

export interface ApiCore {
  chat(stores: ProjectStores, id: string, cursor: number | undefined, signal: AbortSignal): EventStream<RoomMessage>
  subscribeWorkflow(stores: ProjectStores, id: string, receive: (event: import('@taktflow/core').WorkflowChangedEvent) => void, onError: (error: unknown) => void): () => Promise<void>
  read(stores: ProjectStores, op: ReadOp, params: Record<string, string | undefined>, actor?: Actor): Promise<unknown>
  write(stores: ProjectStores, op: WriteOp, params: Record<string, string | undefined>, body: unknown, actor: Actor): Promise<unknown>
  /** 运行事件流：从 cursor 之后开始，signal 结束时停止并清理订阅。 */
  events(stores: ProjectStores, runId: string, cursor: number | undefined, signal: AbortSignal): AsyncIterable<EventEnvelope>
}

export type WriteLease = <T>(stores: ProjectStores, fn: () => Promise<T>) => Promise<T>

export interface ApiCoreOptions extends M3Callbacks {
  onAnswer?: (item: AttentionItem) => void | Promise<void>
  catalog?: CatalogCallbacks
  onLeadMention?: LeadMention
  /** 单写者：所有写操作和答复后的 onAnswer 都在这里面执行；不传则直接执行。 */
  withWriteLease?: WriteLease
}

/** 事件流在历史读取完成前的就绪信号，HTTP SSE 用它保留"读失败返回 JSON 错误"的行为。 */
export interface EventStream<T = EventEnvelope> extends AsyncIterable<T> {
  readonly ready: Promise<void>
}

export function createApiCore(options: ApiCoreOptions = {}): ApiCore {
  const catalog = options.catalog ?? {}
  const workflows = new Map<string, WorkflowStore>()
  const getWorkflow = (stores: ProjectStores) => {
    let store = workflows.get(stores.paths.workflows)
    if (!store) { store = workflowAccess(stores, withWriteLease); workflows.set(stores.paths.workflows, store) }
    return store
  }
  const withWriteLease: WriteLease = async (stores, fn) => {
    try { return await (options.withWriteLease ? options.withWriteLease(stores, fn) : fn()) }
    catch (error) {
      if (isLeaseHeld(error) || error instanceof AttentionStaleError) throw new ApiError(409, errorMessage(error))
      throw error
    }
  }
  const registry = apiCommands(options, withWriteLease)
  const onMessage = (stores: ProjectStores, id: string, message: import('@taktflow/core').RoomMessage) => {
    if (!message.mentions?.includes('lead') || !options.onLeadMention) return
    // 后台 Lead 自己持有完整写生命周期，HTTP 返回不能提前释放它的租约。
    return new Promise<void>((resolve, reject) => {
      void withWriteLease(stores, async () => {
        resolve()
        try { await options.onLeadMention!(id, message) }
        catch (error) {
          await stores.chat.post(id, { kind: 'system', author: { type: 'system', id: 'server' }, replyTo: message.id, text: `Lead 回调失败：${errorMessage(error)}` })
        }
      }).catch(reject)
    })
  }

  return {
    chat(stores, id, cursor, signal) {
      return createEventStream({ read: (_, opts) => stores.chat.list(id, opts), subscribe: (_, receive) => stores.chat.subscribe(id, receive) }, id, cursor, signal, () => requirement(stores, id))
    },
    subscribeWorkflow(stores, id, receive, onError) {
      return getWorkflow(stores).watch((event) => { if (event.workflowId === id) receive(event) }, onError)
    },
    async read(stores, op, params, actor = { type: 'human', id: stores.config.members?.find((member) => member.role === 'owner')?.id ?? 'web' }) {
      switch (op) {
        case 'lessons': return withWriteLease(stores, () => readM3(stores, op, params, actor, registry))
        case 'me': case 'commands': case 'recipe':
        case 'eval.scorecards': case 'eval.cases': case 'eval.runs': case 'eval.run': case 'eval.output': case 'defects': case 'defect':
          return readM3(stores, op, params, actor, registry)
        case 'space': return readSpace(stores, op, params, () => getWorkflow(stores).list())
        case 'space.file': case 'reviews': case 'chat':
          return readSpace(stores, op, params)
        case 'room': {
          const req = await requirement(stores, params.id!)
          const room = await stores.chat.getRoom(req.id) ?? await withWriteLease(stores, () => stores.chat.ensureRoom(req.id, { title: req.title }))
          return { ...room, lead: options.getLeadPresence?.(stores.projectDir, req.id) ?? { state: 'idle', since: req.createdAt } }
        }
        case 'workflows': case 'workflow': case 'workflow.source': case 'workflow.revisions': case 'workflow.revision':
          return readWorkflow(stores, getWorkflow(stores), op, params)
        case 'project':
          return overview(stores)
        case 'requirements':
          return summaries(stores)
        case 'requirement': {
          const item = await requirement(stores, params.id!)
          const [info, artifacts, runs] = await Promise.all([
            summary(stores, item),
            stores.workspaces.listArtifacts(item.id),
            stores.runs.list({ requirementId: item.id }),
          ])
          return { ...info, artifacts, runs: await runSummaries(stores, runs) }
        }
        case 'artifacts':
          await requirement(stores, params.id!)
          return stores.workspaces.listArtifacts(params.id!)
        case 'artifact': {
          await requirement(stores, params.id!)
          const path = artifactPath(params.path)
          const requestedVersion = integer(params.version, 'version', 1)
          const record = (await stores.workspaces.listArtifacts(params.id!)).find((item) => item.path === path)
          const version = requestedVersion ?? record?.versions.at(-1)?.version
          if (!record || version === undefined || !record.versions.some((item) => item.version === version)) throw new ApiError(404, '产物或版本不存在')
          const content = await stores.workspaces.readArtifact({ workspace: params.id!, path, version })
          if (!content) throw new ApiError(404, '产物内容不存在')
          const encoding = isUtf8(content) && !content.includes(0) ? 'utf8' : 'base64'
          return { path, version, mediaType: record.mediaType, content: content.toString(encoding), encoding } satisfies ArtifactContent
        }
        case 'comments': {
          await requirement(stores, params.id!)
          const path = params.path !== undefined ? artifactPath(params.path) : undefined
          return stores.workspaces.listComments(params.id!, path)
        }
        case 'trace':
          await requirement(stores, params.id!)
          return createInsights(stores).traceGraph(params.id!)
        case 'metrics':
          await requirement(stores, params.id!)
          return createInsights(stores).metrics(params.id!)
        case 'runs': {
          const id = params.requirement !== undefined ? safeId(params.requirement) : undefined
          return stores.runs.list(id === undefined ? undefined : { requirementId: id }).then((runs) => runSummaries(stores, runs))
        }
        case 'run': {
          const state = await run(stores, params.runId!)
          const snapshot = await workflow(stores, state.runId)
          const [records, events] = await Promise.all([loadRunGraph(stores, state.runId), stores.events.read(state.runId)])
          return {
            run: state, budget: budgetStatus(state, events), quality: await qualityMetrics(events, { store: stores.workspaces, requirementId: state.requirementId }), usage: summarizeUsage(events),
            stages: stageProgress(snapshot, state, records),
            workflow: { id: snapshot.id, title: snapshot.title, version: snapshot.version, stages: snapshot.stages },
            graph: buildRunGraph(snapshot, state, records, events),
          }
        }
        case 'events': {
          await run(stores, params.runId!)
          const nodeId = params.node !== undefined ? relativePath(params.node) : undefined
          return stores.events.read(params.runId!, { afterSeq: integer(params.after, 'after'), nodeId })
        }
        case 'node':
          return nodeDetail(stores, params.runId!, params.nodeId!)
        case 'audit':
          await run(stores, params.runId!)
          return stores.events.verify(params.runId!)
        case 'attention': {
          const pending = params.pending
          if (pending !== undefined && pending !== '0' && pending !== '1') throw new ApiError(400, 'pending 必须是 0 或 1')
          return withAttentionStaleness(stores, await stores.attention.list({ pending: pending === '1' }))
        }
        case 'harnesses':
          if (catalog.getHarnesses) return catalog.getHarnesses(stores)
          if (catalog.getCatalog) return catalog.getCatalog(stores).then((value) => value.harnesses)
          throw new ApiError(501, '未接入运行时 harnesses 目录')
        case 'models':
          if (catalog.getModels) return catalog.getModels(stores)
          if (catalog.getCatalog) return catalog.getCatalog(stores).then((value) => value.models)
          throw new ApiError(501, '未接入运行时 models 目录')
        default:
          throw new ApiError(400, `未知读操作：${String(op)}`)
      }
    },

    async write(stores, op, params, body, actor) {
      return withWriteLease(stores, () => dispatchWrite(stores, op, params, body, actor))
    },

    events(stores, runId, cursor, signal) {
      return createEventStream(stores.events, runId, cursor, signal, () => run(stores, runId))
    },
  }

  async function dispatchWrite(stores: ProjectStores, op: WriteOp, params: Record<string, string | undefined>, body: unknown, actor: Actor): Promise<unknown> {
    if (!['command.run', 'route.preview'].includes(op)) {
      const role = op === 'space.members' ? 'owner' : ['space.repo.add', 'space.repo.update', 'space.repo.sync', 'space.file.edit'].includes(op) ? 'maintainer' : 'member'
      try { requireRole(stores, actor, role, op) } catch (error) { throw new ApiError(403, errorMessage(error)) }
    }
    switch (op) {
      case 'command.run': case 'route.preview': case 'lesson.update': case 'review.dispose':
      case 'eval.collect': case 'defect.report': case 'defect.confirm':
        return writeM3(stores, op, params, await inputOf(body), actor, registry)
      case 'eval.run': case 'defect.attribute': {
        const input = await inputOf(body)
        if (!options.getCommands && !options.resolveRuntime) throw new ApiError(501, '未接入评测运行时')
        return writeM3(stores, op, params, input, actor, registry)
      }
      case 'space.members': case 'space.repo.add': case 'space.repo.update': case 'space.repo.sync': case 'space.file.edit': case 'room.members': case 'chat.send':
        return writeSpace({ stores, params, input: await inputOf(body), author: actor }, op, onMessage)
      case 'workflow.edit': case 'workflow.source.replace': case 'workflow.layout': case 'workflow.rollback':
        return writeWorkflow(getWorkflow(stores), op, params, await inputOf(body), actor)
      case 'artifact.edit': {
        await requirement(stores, params.id!)
        const path = artifactPath(params.path)
        const input = await inputOf(body)
        const content = text(input.content, 'content', true)
        const reason = text(input.reason, 'reason')
        if (input.impact !== undefined && !['cosmetic', 'semantic'].includes(String(input.impact))) throw new ApiError(400, 'impact 不合法')
        return serialize(stores.projectDir, async () => {
          const record = (await stores.workspaces.listArtifacts(params.id!)).find((item) => item.path === path)
          const ref = await stores.workspaces.writeArtifact({
            ref: { workspace: params.id!, path }, content, reason, author: actor,
            kind: record?.kind ?? 'other', title: record?.title, tags: record?.tags,
          })
          const staleNodes = ref.version === record?.versions.at(-1)?.version ? [] : await markArtifactEdited(stores, ref, actor, reason, input.impact as 'cosmetic' | 'semantic' | undefined)
          return { version: ref.version, staleNodes }
        })
      }
      case 'comment.add': {
        await requirement(stores, params.id!)
        const input = await inputOf(body)
        const path = artifactPath(input.path)
        if (typeof input.version !== 'number' || !Number.isSafeInteger(input.version) || input.version < 1) throw new ApiError(400, 'version 必须是正整数')
        const version = input.version
        const content = text(input.body, 'body')
        const record = (await stores.workspaces.listArtifacts(params.id!)).find((item) => item.path === path)
        if (!record?.versions.some((item) => item.version === version)) throw new ApiError(404, '产物或版本不存在')
        return stores.workspaces.addComment(params.id!, { path, version, body: content, author: actor })
      }
      case 'attention.answer': {
        const input = await inputOf(body)
        const decision = input.decision === undefined ? undefined : text(input.decision, 'decision')
        const answer = input.answer === undefined ? undefined : text(input.answer, 'answer')
        if (decision === undefined && answer === undefined) throw new ApiError(400, 'decision 或 answer 至少填写一项')
        const item = await registry.execute(stores, actor, 'attention.answer', { requestId: params.requestId, decision, answer }, typeof input.reason === 'string' ? input.reason : '人工回答待办') as AttentionItem
        await options.onAnswer?.(item)
        return item
      }
      default:
        throw new ApiError(400, `未知写操作：${String(op)}`)
    }
  }
}

/** HTTP 路由可以传 `() => body(request)` 延迟读取请求体，让参数校验保持在校验失败优先的原有顺序。 */
async function inputOf(source: unknown): Promise<Record<string, unknown>> {
  const value = typeof source === 'function' ? await (source as () => unknown)() : await source
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ApiError(400, '请求体必须是对象')
  return value as Record<string, unknown>
}

function isLeaseHeld(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'TAKT_LEASE_HELD'
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'object' && error !== null) {
    const message = (error as { message?: unknown }).message
    if (typeof message === 'string') return message
  }
  return String(error)
}

function cursorValue(cursor: number | undefined): number {
  if (cursor === undefined) return 0
  if (!Number.isSafeInteger(cursor) || cursor < 0) throw new ApiError(400, 'after 不合法')
  return cursor
}

function createEventStream<T extends { seq: number }>(source: SequenceSource<T>, runId: string, cursor: number | undefined, signal: AbortSignal, validate: () => Promise<unknown>): EventStream<T> {
  const queue: T[] = []
  let feed: EventFeed | undefined
  let wake: (() => void) | undefined
  let closed = false
  let started: Promise<void> | undefined
  let releaseClosed: (() => void) | undefined
  // abort 与 return 共用同一个关闭完成信号，所有等待都和它竞速，关闭后不再等待校验或历史读取。
  const closedPromise = new Promise<void>((resolve) => { releaseClosed = resolve })

  const stop = () => {
    if (closed) return
    closed = true
    feed?.close()
    signal.removeEventListener('abort', stop)
    releaseClosed?.()
    wake?.()
    wake = undefined
    queue.length = 0
  }

  // 先装监听再开始校验：run 读取期间 abort 也能立即结束，不会晚一步才订阅。
  signal.addEventListener('abort', stop, { once: true })
  if (signal.aborted) stop()

  const start = (): Promise<void> => {
    if (started) return started
    started = (async () => {
      try {
        if (closed) return
        await Promise.race([validate(), closedPromise])
        if (closed) return
        const after = cursorValue(cursor)
        if (closed) return
        feed = createEventFeed(source, runId, after, (event) => {
          queue.push(event)
          wake?.()
          wake = undefined
        })
        await Promise.race([feed.ready, closedPromise])
        if (closed) stop()
      } catch (error) {
        // 启动失败也必须走 stop()，否则构造时装的 abort 监听会一直挂在 signal 上。
        stop()
        throw error
      }
    })()
    // 关闭后可能没人再等 start()，后台校验或历史读取的失败不能变成未处理拒绝。
    started.catch(() => {})
    return started
  }

  const iterator: AsyncIterator<T> = {
    async next() {
      await start()
      while (!closed) {
        const event = queue.shift()
        if (event) return { done: false, value: event }
        await Promise.race([new Promise<void>((resolve) => { wake = resolve }), closedPromise])
      }
      return { done: true, value: undefined }
    },
    async return() {
      stop()
      return { done: true, value: undefined }
    },
  }

  return {
    get ready() { return start() },
    [Symbol.asyncIterator]() { return iterator },
  }
}
