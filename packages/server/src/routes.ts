import { pairingMatrix } from './pairings.js'
import { automationRoutes, type AutomationCallbacks } from './automation-routes.js'
import { agentRoutes } from './agent-routes.js'
import { runtimeRoutes, type RuntimeCallbacks } from './runtime-routes.js'
import { qualityRoutes } from './quality-routes.js'
import { runInsightRoutes } from './run-insight-routes.js'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { isUtf8 } from 'node:buffer'
import { runLiveness, nodeActivity, budgetStatus, qualityMetrics, summarizeUsage, withAttentionStaleness, loadRunGraph, markArtifactEdited, buildRunGraph, stageProgress, createInsights, type ArtifactContent, type AttentionItem, type EventType, type ProjectStores } from '@taktflow/core'
import { actor, artifactPath, body, HttpError, integer, relativePath, safeId, text } from './http.js'
import { registerEvalRoutes } from './eval-routes.js'
import { commandExecutor, m3Routes, type M3Callbacks } from './m3-routes.js'
import type { CatalogCallbacks } from './catalog.js'
import { nodeDetail, overview, requirement, run, summaries, summary, runSummaries, workflow } from './read-model.js'
import { createRouter } from './router.js'
import { serialize } from './stale.js'
import { stream } from './stream.js'
import { spaceRoutes, type LeadMention } from './space-routes.js'
import { workflowRoutes } from './workflow-routes.js'
import { registerKnowledgeRoutes } from './knowledge-routes.js'
import { createSecretResolver } from '@taktflow/knowledge'
import { crudRoutes } from './crud-routes.js'
import { workflowSource } from './space.js'
import type { WorkflowStore } from '@taktflow/workflow-source'

export interface RequestContext {
  stores: ProjectStores
  request: IncomingMessage
  response: ServerResponse
  url: URL
  params: Record<string, string>
}

export type Handler = (context: RequestContext) => Promise<unknown> | unknown
export const STREAMING = Symbol('streaming')

export function routes(connections: Set<() => void>, onAnswer?: (item: AttentionItem) => void | Promise<void>, catalog: CatalogCallbacks & M3Callbacks & RuntimeCallbacks & AutomationCallbacks = {}, onLeadMention?: LeadMention) {
  const router = createRouter<Handler>()
  const add = router.add
  const { execute } = commandExecutor(catalog)
  const workflows = new Map<string, WorkflowStore>()
  automationRoutes(add, catalog)
  agentRoutes(add, catalog)
  runtimeRoutes(add, catalog)
  qualityRoutes(add, catalog)
  runInsightRoutes(add)
  registerKnowledgeRoutes(add, { connections })
  crudRoutes(add, catalog)
  spaceRoutes(add, connections, onLeadMention, catalog)
  m3Routes(add, catalog)
  registerEvalRoutes(add, catalog.resolveRuntime ?? (() => { throw new HttpError(501, '未接入评测运行时') }), catalog)
  workflowRoutes(add, connections, (stores) => {
    let store = workflows.get(stores.paths.workflows)
    if (!store) { store = workflowSource(stores); workflows.set(stores.paths.workflows, store) }
    return store
  })
  add('GET', '/api/project', ({ stores }) => overview(stores))
  add('GET', '/api/requirements', ({ stores, url }) => summaries(stores, url.searchParams.get('archived') === '1'))
  add('GET', '/api/requirements/:id', async ({ stores, params }) => {
    const item = await requirement(stores, params.id!)
    const [info, artifacts, runs] = await Promise.all([summary(stores, item), stores.workspaces.listArtifacts(item.id), stores.runs.list({ requirementId: item.id })])
    return { ...info, artifacts, runs: await runSummaries(stores, runs) }
  })
  add('GET', '/api/requirements/:id/artifacts', async ({ stores, params }) => {
    await requirement(stores, params.id!)
    return stores.workspaces.listArtifacts(params.id!)
  })
  add('GET', '/api/requirements/:id/artifact', async ({ stores, params, url }): Promise<ArtifactContent> => {
    await requirement(stores, params.id!)
    const path = artifactPath(url.searchParams.get('path'))
    const requestedVersion = integer(url.searchParams.get('version'), 'version', 1)
    const record = (await stores.workspaces.listArtifacts(params.id!)).find((item) => item.path === path)
    const version = requestedVersion ?? record?.versions.at(-1)?.version
    if (!record || version === undefined || !record.versions.some((item) => item.version === version)) throw new HttpError(404, '产物或版本不存在')
    const content = await stores.workspaces.readArtifact({ workspace: params.id!, path, version })
    if (!content) throw new HttpError(404, '产物内容不存在')
    const encoding = isUtf8(content) && !content.includes(0) ? 'utf8' : 'base64'
    return { path, version, mediaType: record.mediaType, content: content.toString(encoding), encoding }
  })
  add('PUT', '/api/requirements/:id/artifact', async ({ stores, params, url, request }) => {
    await requirement(stores, params.id!)
    const path = artifactPath(url.searchParams.get('path'))
    const input = await body(request)
    const content = text(input.content, 'content', true)
    const reason = text(input.reason, 'reason')
    if (input.impact !== undefined && !['cosmetic', 'semantic'].includes(String(input.impact))) throw new HttpError(400, 'impact 不合法')
    return serialize(stores.projectDir, async () => {
      const record = (await stores.workspaces.listArtifacts(params.id!)).find((item) => item.path === path)
      const author = actor(request, stores)
      const ref = await stores.workspaces.writeArtifact({ ref: { workspace: params.id!, path }, content, reason, author, kind: record?.kind ?? 'other', title: record?.title, tags: record?.tags })
      const staleNodes = ref.version === record?.versions.at(-1)?.version ? [] : await markArtifactEdited(stores, ref, author, reason, input.impact as 'cosmetic' | 'semantic' | undefined)
      return { version: ref.version, staleNodes }
    })
  })
  add('GET', '/api/requirements/:id/comments', async ({ stores, params, url }) => {
    await requirement(stores, params.id!)
    const path = url.searchParams.has('path') ? artifactPath(url.searchParams.get('path')) : undefined
    return stores.workspaces.listComments(params.id!, path)
  })
  add('POST', '/api/requirements/:id/comments', async ({ stores, params, request }) => {
    await requirement(stores, params.id!)
    const input = await body(request)
    const path = artifactPath(input.path)
    if (typeof input.version !== 'number' || !Number.isSafeInteger(input.version) || input.version < 1) throw new HttpError(400, 'version 必须是正整数')
    const version = input.version
    const content = text(input.body, 'body')
    const record = (await stores.workspaces.listArtifacts(params.id!)).find((item) => item.path === path)
    if (!record?.versions.some((item) => item.version === version)) throw new HttpError(404, '产物或版本不存在')
    return stores.workspaces.addComment(params.id!, { path, version, body: content, author: actor(request, stores) })
  })
  add('GET', '/api/requirements/:id/trace', async ({ stores, params }) => {
    await requirement(stores, params.id!)
    return createInsights(stores).traceGraph(params.id!)
  })
  add('GET', '/api/requirements/:id/metrics', async ({ stores, params }) => {
    await requirement(stores, params.id!)
    return createInsights(stores).metrics(params.id!)
  })
  add('GET', '/api/runs', ({ stores, url }) => {
    const id = url.searchParams.get('requirement')
    return stores.runs.list(id === null ? undefined : { requirementId: safeId(id) }).then((runs) => runSummaries(stores, runs))
  })
  add('GET', '/api/runs/:runId', async ({ stores, params }) => {
    const state = await run(stores, params.runId!)
    const snapshot = await workflow(stores, state.runId)
    const [records, events] = await Promise.all([loadRunGraph(stores, state.runId), stores.events.read(state.runId)])
    const graph = buildRunGraph(snapshot, state, records, events)
    for (const node of graph.nodes) if (state.nodes[node.id]?.status === 'running' && ['agent', 'judge'].includes(node.kind)) node.activity = nodeActivity(events.filter(e => e.nodeId === node.id))
    return { run: state, ...(await runLiveness(stores, state.runId, state) === 'interrupted' ? { interrupted: true } : {}), budget: budgetStatus(state, events), quality: await qualityMetrics(events, { store: stores.workspaces, requirementId: state.requirementId }), usage: summarizeUsage(events), stages: stageProgress(snapshot, state, records), workflow: { id: snapshot.id, title: snapshot.title, version: snapshot.version, stages: snapshot.stages }, graph }
  })
  add('GET', '/api/runs/:runId/events', async ({ stores, params, url }) => {
    await run(stores, params.runId!)
    const nodeId = url.searchParams.has('node') ? relativePath(url.searchParams.get('node')) : undefined
    // types 只取这些类型、last 只要最后 N 条：长运行的完整日志可能几百 MB，界面不能整份下载。
    const types = url.searchParams.get('types')?.split(',').filter(Boolean) as EventType[] | undefined
    const last = integer(url.searchParams.get('last'), 'last', 1)
    const events = await stores.events.read(params.runId!, { afterSeq: integer(url.searchParams.get('after'), 'after'), nodeId, types })
    return last === undefined ? events : events.slice(-last)
  })
  add('GET', '/api/runs/:runId/stream', async ({ stores, params, url, response, request }) => {
    await run(stores, params.runId!)
    // ?from=tail：只推之后的新事件（界面只拿它当"有变化"信号，长运行的历史可能几十万条）；断线重连带 Last-Event-ID 时按游标补。
    const cursor = url.searchParams.get('after') ?? (typeof request.headers['last-event-id'] === 'string' ? request.headers['last-event-id'] : null)
    const after = cursor === null && url.searchParams.get('from') === 'tail' ? 'tail' : integer(cursor, 'after') ?? 0
    await stream(stores.events, params.runId!, after, response, connections)
    return STREAMING
  })
  add('GET', '/api/runs/:runId/nodes/:nodeId', ({ stores, params }) => nodeDetail(stores, params.runId!, params.nodeId!))
  add('GET', '/api/runs/:runId/audit', async ({ stores, params }) => {
    await run(stores, params.runId!)
    return stores.events.verify(params.runId!)
  })
  add('GET', '/api/attention', async ({ stores, url }) => {
    const pending = url.searchParams.get('pending')
    if (pending !== null && pending !== '0' && pending !== '1') throw new HttpError(400, 'pending 必须是 0 或 1')
    return withAttentionStaleness(stores, await stores.attention.list({ pending: pending === '1' }))
  })
  add('POST', '/api/attention/:requestId', async ({ stores, params, request }) => {
    const input = await body(request)
    const decision = input.decision === undefined ? undefined : text(input.decision, 'decision')
    const answer = input.answer === undefined ? undefined : text(input.answer, 'answer')
    if (decision === undefined && answer === undefined) throw new HttpError(400, 'decision 或 answer 至少填写一项')
    const item = await execute(stores, request, 'attention.answer', { requestId: params.requestId, decision, answer }, typeof input.reason === 'string' ? input.reason : '人工回答待办') as AttentionItem
    // 接入运行时命令后，attention.answer 已负责续跑；回调只用于没有运行时的存储模式。
    if (!catalog.getCommands && item.kind !== 'assumption') await onAnswer?.(item)
    return item
  })
  add('GET', '/api/pairings', async ({ stores }) => {
    const rows = catalog.getHarnesses ? await catalog.getHarnesses(stores) : catalog.getCatalog ? (await catalog.getCatalog(stores)).harnesses : undefined
    if (!rows) throw new HttpError(501, '未接入运行时 harnesses 目录')
    return pairingMatrix(stores.config, rows, catalog.bridge)
  })
  add('GET', '/api/harnesses', ({ stores }) => {
    if (catalog.getHarnesses) return catalog.getHarnesses(stores)
    if (catalog.getCatalog) return catalog.getCatalog(stores).then((value) => value.harnesses)
    throw new HttpError(501, '未接入运行时 harnesses 目录')
  })
  add('GET', '/api/models', ({ stores }) => {
    if (catalog.getModels) return catalog.getModels(stores)
    if (catalog.getCatalog) return catalog.getCatalog(stores).then((value) => value.models)
    throw new HttpError(501, '未接入运行时 models 目录')
  })
  return router
}
