import { dirname, join, resolve } from 'node:path'
import { readdir } from 'node:fs/promises'
import { applyEdits } from '@taktflow/workflow-source'
import {
  findEntities,
  findInput,
  findLimit,
  stewardPicks,
  StewardAgent,
  StewardError,
  stewardId,
  stewardUserId,
  stewardActor,
  buildDigest,
  refreshRisks,
  setRiskState,
  productMetrics,
  recordProductEvent,
  stewardSuggestions,
  startDigestScheduler,
  unreadFeed,
  requireRole,
  openProject,
  stewardUndoCommands,
  type CommandRegistry,
  type ProjectStores,
  type StewardDeps,
  type StewardPrefs,
  type StewardPostRequest,
  type ProposalDecisionRequest,
  type ProductEvent,
  type RiskStateRequest,
  type StewardFeedItem,
  type StewardStreamEvent,
} from '@taktflow/core'
import {
  discoverSpaces,
  spaceId,
  spaceSummary,
  workflowStore,
  projectCommands,
  auditSpace,
} from './space.js'
import { createServerCommandRegistry } from './space-admin.js'
import { actor, body, HttpError, text, validateWriteRequest } from './http.js'
import { liveStream } from './live-stream.js'
import { STREAMING, type Handler, type RequestContext } from './routes.js'
import type { LeadMention } from './space-routes.js'

export interface StewardRouteDeps {
  spacesDir?: string
  projectDir?: string
  registry?: Map<string, ProjectStores>
  serverCommands?: CommandRegistry
  onLeadMention?: (
    dir: string,
    requirementId: string,
    message: Parameters<LeadMention>[1],
  ) => void | Promise<void>
  commands?: (stores: ProjectStores) => CommandRegistry | Promise<CommandRegistry>
  resolveChat?: (prefs: StewardPrefs) => Promise<StewardDeps['chat']>
  prepareStores?: (stores: ProjectStores) => Promise<ProjectStores>
  connections?: Set<() => void>
  steward?: Partial<
    Pick<StewardDeps, 'chat' | 'now' | 'extraRisks' | 'systemPrompt' | 'leadTimeoutMs'>
  >
}
export function createStewardDeps(options: StewardRouteDeps, userId: string): StewardDeps {
  const by = { type: 'human' as const, id: stewardUserId(userId) }
  const all = async () => {
    const fresh = options.registry
      ? await Promise.all([...options.registry.values()].map((s) => openProject(s.projectDir)))
      : options.spacesDir
        ? await discoverSpaces(options.spacesDir)
        : [await openProject(options.projectDir ?? process.cwd())]
    return Promise.all(
      fresh.map(async (stores) => {
        stores.kb ??= options.registry?.get(spaceId(stores))?.kb
        return options.prepareStores ? options.prepareStores(stores) : stores
      }),
    )
  }
  return {
    ...options.steward,
    dataDir: (id) =>
      options.spacesDir
        ? join(resolve(options.spacesDir), '.steward', stewardUserId(id))
        : join(resolve(options.projectDir ?? process.cwd()), '.takt/steward', stewardUserId(id)),
    spaces: async () => {
      const visible = (await all()).filter((stores) => {
        try {
          requireRole(stores, by, 'viewer', '查询空间')
          return true
        } catch {
          return false
        }
      })
      return Promise.all(visible.map(spaceSummary))
    },
    open: async (id) => {
      stewardId(id)
      const stores = (await all()).find((s) => spaceId(s) === id)
      if (!stores) throw new StewardError(404, '空间不存在，请刷新空间列表')
      try {
        requireRole(stores, by, 'viewer', '管家查询空间')
      } catch {
        throw new StewardError(403, '没有该空间的访问权限，请联系空间管理员')
      }
      const workflows = workflowStore(stores)
      const local = projectCommands(stores)
      const commands: CommandRegistry = {
        list: () => local.list(),
        run: async (commandId, input, context) => {
          const runtime =
            options.commands && /^(run\.|task\.)/.test(commandId)
              ? await options.commands(stores)
              : local
          return runtime.run(commandId, input, context)
        },
      }
      return {
        id,
        name: stores.config.project.name,
        dir: stores.projectDir,
        stores,
        commands: stewardUndoCommands(stores, commands, (by, reason, message) =>
          auditSpace(stores, by, reason, message),
        ),
        workflows,
        onChat: (req, listener) => stores.chat.subscribe(stewardId(req), listener),
        postToLead: async (req, message) => {
          try {
            requireRole(stores, by, 'member', '转达 Lead')
          } catch {
            throw new StewardError(403, '转达 Lead 需要成员权限，请联系管理员')
          }
          if (!options.onLeadMention)
            throw new StewardError(503, 'Lead 执行器尚未接入，请联系管理员接入后再转达')
          const posted = await stores.chat.post(stewardId(req), {
            author: stewardActor,
            kind: 'text',
            text: message,
            mentions: ['lead'],
          })
          void Promise.resolve()
            .then(() => options.onLeadMention!(stores.projectDir, req, posted))
            .catch(async (error: unknown) => {
              await stores.chat.post(req, {
                author: { type: 'agent', role: 'lead', harness: 'steward' },
                kind: 'text',
                replyTo: posted.id,
                text: `Lead 执行失败，请重试：${String(error)}`,
              })
            })
          return posted.id
        },
      }
    },
    serverCommands: options.serverCommands ?? createServerCommandRegistry(options),
    applyWorkflowEdits: applyEdits,
  }
}
function prefs(value: Record<string, unknown>): StewardPrefs {
  if (
    !['confirm', 'auto-low'].includes(String(value.trust)) ||
    !Array.isArray(value.digestTimes) ||
    value.digestTimes.some((v) => typeof v !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(v))
  )
    throw new HttpError(400, '信任档位或汇报时间不合法，请重新选择')
  for (const key of ['watchedSpaces', 'mutedSpaces'])
    if (
      value[key] !== undefined &&
      (!Array.isArray(value[key]) || (value[key] as unknown[]).some((v) => typeof v !== 'string'))
    )
      throw new HttpError(400, '空间列表格式错误，请重新选择')
  if (value.quietHours !== undefined) {
    const q = value.quietHours as { from?: string; to?: string }
    if (
      !q ||
      ![q.from, q.to].every((v) => typeof v === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(v))
    )
      throw new HttpError(400, '免打扰时间不合法，请使用 HH:MM')
  }
  if (value.defaultSpace !== undefined) stewardId(text(value.defaultSpace, '默认空间'))
  if (
    value.harness !== undefined &&
    (!value.harness ||
      typeof value.harness !== 'object' ||
      typeof (value.harness as { harness?: unknown }).harness !== 'string')
  )
    throw new HttpError(400, '模型配置格式错误，请重新选择')
  return value as unknown as StewardPrefs
}
export function registerStewardRoutes(
  router:
    | { add(method: string, path: string, handler: Handler): void }
    | ((method: string, path: string, handler: Handler) => void),
  deps: StewardDeps | StewardRouteDeps,
) {
  const add = typeof router === 'function' ? router : router.add.bind(router)
  const agents = new Map<string, StewardAgent>(),
    schedulers = new Map<string, ReturnType<typeof startDigestScheduler>>()
  const connections =
    'connections' in deps ? (deps.connections ?? new Set<() => void>()) : new Set<() => void>()
  let closed = false
  const ensureAgent = (id: string) => {
    let agent = agents.get(id)
    if (!agent) {
      if (agents.size >= 128)
        throw new HttpError(429, '管家活跃用户已达上限，请稍后重试或联系管理员')
      agent = new StewardAgent('dataDir' in deps ? deps : createStewardDeps(deps, id), id)
      agents.set(id, agent)
      const current = agent
      schedulers.set(
        id,
        startDigestScheduler(
          current.deps,
          () => [current.store],
          (error) => {
            void current.store
              .append('scheduler-errors.jsonl', {
                at: new Date().toISOString(),
                error: String(error),
              })
              .catch(() => {})
          },
        ),
      )
    }
    return agent
  }
  const get = async (ctx: RequestContext) => {
    const by = actor(ctx.request, ctx.stores)
    if (by.type !== 'human') throw new HttpError(403, '管家需要用户身份')
    const agent = ensureAgent(stewardUserId(by.id))
    if ('resolveChat' in deps && deps.resolveChat)
      agent.deps.chat = await deps.resolveChat(await agent.store.prefs())
    return { agent, by, store: agent.store }
  }
  const ready = (async () => {
    const root = dirname(
      ('dataDir' in deps ? deps : createStewardDeps(deps, 'steward-discovery')).dataDir(
        'steward-discovery',
      ),
    )
    let entries
    try {
      entries = await readdir(root, { withFileTypes: true })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    for (const entry of entries) {
      if (closed) return
      if (!entry.isDirectory()) continue
      const { access } = await import('node:fs/promises')
      if (
        !(await access(join(root, entry.name, 'prefs.json')).then(
          () => true,
          () => false,
        ))
      )
        continue
      if (agents.size >= 128) break
      await ensureAgent(stewardUserId(entry.name)).ready
    }
  })()
  void ready.catch(() => {})
  const route = (
    method: string,
    path: string,
    handler: (ctx: RequestContext, service: Awaited<ReturnType<typeof get>>) => Promise<unknown>,
  ) =>
    add(method, `/api/steward${path}`, async (ctx) => {
      try {
        validateWriteRequest(ctx.request)
        await ready
        const service = await get(ctx)
        await service.agent.ready
        return await handler(ctx, service)
      } catch (error) {
        if (error instanceof StewardError) throw new HttpError(error.status, error.message)
        throw error
      }
    })
  route('POST', '/delegations/:messageId/resend', async ({ params, request }, { agent }) => agent.tools.resendDelegation(params.messageId!, text((await body(request)).reason, 'reason')))
  route('GET', '/find', async ({ url }, { agent, store }) => {
    const params = url.searchParams
    const input = findInput({ q: params.get('q'), types: params.has('types') ? params.get('types')!.split(',') : undefined, spaceId: params.get('spaceId') ?? params.get('space') ?? undefined, limit: params.has('limit') ? Number(params.get('limit')) : undefined })
    return findEntities(agent.deps, input, await store.prefs())
  })
  route('GET', '/picks', async ({ url }, { agent, store }) => ({
    items: await stewardPicks(agent.deps, await store.prefs(), findLimit(url.searchParams.has('limit') ? Number(url.searchParams.get('limit')) : undefined, 6)),
  }))
  route('GET', '/threads', async ({ url }, { store }) =>
    store.threads(url.searchParams.get('q') ?? url.searchParams.get('search') ?? ''),
  )
  route('POST', '/threads', async ({ request }, { agent }) => {
    const result = await agent.post((await body(request)) as unknown as StewardPostRequest)
    return { thread: result.thread, message: result.message }
  })
  route('GET', '/threads/:id', async ({ params }, { store }) => ({
    thread: await store.thread(params.id!),
    messages: await store.messages(params.id!),
    proposals: (await store.list<import('@taktflow/core').Proposal>('proposals')).filter(
      (p) => p.threadId === params.id,
    ),
  }))
  route(
    'POST',
    '/threads/:id/messages',
    async ({ request, params }, { agent }) =>
      (await agent.post((await body(request)) as unknown as StewardPostRequest, params.id!))
        .message,
  )
  route('GET', '/threads/:id/stream', async ({ response, params }, { store }) => {
    await store.thread(params.id!)
    liveStream<StewardStreamEvent>(response, connections, (send, fail) => {
      const buffered: StewardStreamEvent[] = []
      let replaying = true
      const off = store.onThread(params.id!, (event) => {
        if (replaying) buffered.push(event)
        else send(event)
      })
      void store
        .messages(params.id!)
        .then((messages) => {
          for (const message of messages) {
            send({ type: 'message', message })
            if (message.role === 'steward' && message.status !== 'streaming')
              send({ type: 'done', messageId: message.id })
          }
          replaying = false
          for (const event of buffered) send(event)
        })
        .catch(fail)
      return off
    })
    return STREAMING
  })
  route('POST', '/messages/:id/feedback', async ({ request, params }, { agent }) => {
    const input = await body(request)
    return agent.feedback(
      stewardId(params.id!),
      input.rating as 'up' | 'down',
      input.reason === undefined ? undefined : text(input.reason, '反馈原因'),
    )
  })
  route('GET', '/proposals', async ({ url }, { store }) =>
    (await store.list<import('@taktflow/core').Proposal>('proposals')).filter(
      (p) => !url.searchParams.get('status') || p.status === url.searchParams.get('status'),
    ),
  )
  route('POST', '/proposals/:id/approve', async ({ request, params }, { agent, by }) =>
    agent.proposals.approve(
      params.id!,
      (await body(request)) as unknown as ProposalDecisionRequest,
      by,
    ),
  )
  for (const action of ['reject', 'undo'] as const)
    route('POST', `/proposals/:id/${action}`, async ({ request, params }, { agent, by }) => {
      const input = await body(request, true)
      return agent.proposals[action](
        params.id!,
        by,
        input.reason === undefined ? undefined : text(input.reason, '原因'),
      )
    })
  route('GET', '/risks', async ({ url }, { agent, store }) =>
    (await refreshRisks(agent.deps, store)).filter(
      (risk) =>
        (!url.searchParams.get('space') || risk.spaceId === url.searchParams.get('space')) &&
        (!url.searchParams.get('state') || risk.state === url.searchParams.get('state')),
    ),
  )
  route('POST', '/risks/:key/state', async ({ request, params }, { agent, store }) =>
    setRiskState(
      agent.deps,
      store,
      params.key!,
      (await body(request)) as unknown as RiskStateRequest,
    ),
  )
  route('GET', '/digest', async ({ url }, { agent, store }) =>
    buildDigest(
      agent.deps,
      store,
      url.searchParams.get('since') ?? undefined,
      true,
      url.searchParams.get('peek') === '1',
    ),
  )
  route('GET', '/feed', async (_, { store }) => store.lines<StewardFeedItem>('feed.jsonl'))
  route('GET', '/prefs', async (_, { store }) => store.prefs())
  route('PUT', '/prefs', async ({ request }, { store, by }) => {
    const input = prefs(await body(request))
    await store.serial(async () => {
      await store.write('prefs.json', input)
      await store.append('audit.jsonl', {
        actor: by,
        at: new Date().toISOString(),
        reason: '用户修改管家偏好',
        action: 'prefs.update',
      })
    })
    return input
  })
  route('GET', '/profile', async (_, { store }) => ({ content: await store.text('profile.md') }))
  route('PUT', '/profile', async ({ request }, { store, by }) => {
    const input = await body(request),
      content = text(input.content, '记忆内容', true)
    await store.serial(async () => {
      await store.writeText('profile.md', content)
      await store.append('audit.jsonl', {
        actor: by,
        at: new Date().toISOString(),
        reason: '用户编辑管家记忆',
        action: 'profile.write',
      })
    })
    return { content }
  })
  route('GET', '/suggestions', async ({ url }, { agent }) =>
    stewardSuggestions(
      agent.deps,
      url.searchParams.get('page') ?? 'overview',
      url.searchParams.get('space') ?? undefined,
      url.searchParams.get('id') ?? undefined,
    ),
  )
  route('GET', '/metrics', async (_, { agent, store }) => productMetrics(agent.deps, store))
  route('POST', '/events', async ({ request, response }, { agent, store }) => {
    await recordProductEvent(agent.deps, store, (await body(request)) as unknown as ProductEvent)
    response.writeHead(204)
    response.end()
    return STREAMING
  })
  route('GET', '/stream', async ({ response }, { store }) => {
    liveStream<StewardFeedItem>(response, connections, (send, fail) => {
      const off = store.onFeed(send)
      void unreadFeed(store)
        .then((count) => send({ type: 'unread', at: new Date().toISOString(), count }))
        .catch(fail)
      return off
    })
    return STREAMING
  })
  return {
    agents,
    ready,
    async close() {
      closed = true
      for (const scheduler of schedulers.values()) scheduler.close()
      await ready.catch(() => {})
      await Promise.allSettled([...agents.values()].map((agent) => agent.drain()))
      for (const agent of agents.values()) agent.close()
      for (const close of connections) close()
    },
  }
}
