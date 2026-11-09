import { AutomationRuntime } from './automation-runtime.js'
import type { RuntimeCallbacks } from './runtime-routes.js'
import { startMaintenance } from './maintenance.js'
import { createServer as httpServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { openProject, StewardStore, StewardError, type AttentionItem } from '@taktflow/core'
import { createRouter } from './router.js'
import { knowledgeRisks } from '@taktflow/knowledge'
import { attachKnowledge, stewardModel } from './knowledge-runtime.js'
import { registerStewardRoutes, createStewardDeps } from './steward-routes.js'
import { createServerCommandRegistry, listSpaces, serverInfo } from './space-admin.js'
import { serverCrudRoutes } from './crud-routes.js'
import type { Handler } from './routes.js'
import { attachCrudServices, discoverSpaces, spaceSummary, spaceId } from './space.js'
import type { LeadMention } from './space-routes.js'
import type { CatalogCallbacks } from './catalog.js'
import { actor, authorize, validateWriteRequest, fail, HttpError, json } from './http.js'
import { routes, STREAMING } from './routes.js'
import { attachLessons } from './commands.js'
import type { M3Callbacks } from './m3-routes.js'
import { staticFile } from './static.js'

export interface ServerOptions extends CatalogCallbacks, M3Callbacks, RuntimeCallbacks {
  onSpaceLoad?: (stores: import('@taktflow/core').ProjectStores) => Promise<void>
  onSpaceUnload?: (projectDir: string) => Promise<void>
  automationFetch?: typeof fetch
  projectDir?: string
  spacesDir?: string
  onLeadMention?: LeadMention
  onSpaceLeadMention?: (projectDir: string, requirementId: string, message: Parameters<LeadMention>[1]) => void | Promise<void>
  onSpaceAnswer?: (projectDir: string, item: AttentionItem) => void | Promise<void>
  port?: number
  host?: string
  webDir?: string
  onAnswer?: (item: AttentionItem) => void | Promise<void>
}

export interface RunningServer { url: string; close(): Promise<void> }

export async function createServer(options: ServerOptions): Promise<RunningServer> {
  if (options.spacesDir && options.projectDir) throw new Error('projectDir 与 spacesDir 不能同时指定')
  let spaces = options.spacesDir ? await discoverSpaces(options.spacesDir) : [await openProject(options.projectDir ?? process.cwd())]
  for (const space of spaces) await options.onSpaceLoad?.(space)
  const byId = new Map(spaces.map((space) => [spaceId(space), space]))
  const rememberStores = (stores: import('@taktflow/core').ProjectStores) => {
    const index = spaces.findIndex(space => space.projectDir === stores.projectDir)
    if (index !== -1) { spaces[index] = stores; byId.set(spaceId(stores), stores) }
  }
  const connections = new Set<() => void>()
  let automationUrl = ''
  const automations = new Map<string, Promise<AutomationRuntime>>()
  const automationRuntime = (stores: import('@taktflow/core').ProjectStores): Promise<AutomationRuntime> => {
    rememberStores(stores)
    let pending = automations.get(stores.projectDir)
    if (!pending) {
      const runtime = new AutomationRuntime(stores.projectDir, { ...options, publicUrl: automationUrl, multiSpace: !!options.spacesDir, fetch: options.automationFetch,
        getStores: () => spaces.find(space => space.projectDir === stores.projectDir) ?? stores,
        onError: () => { process.stderr.write('自动化维护失败，请检查空间配置与文件权限后重试\n') } })
      pending = runtime.start().then(() => runtime).catch(async error => { automations.delete(stores.projectDir); await runtime.close(); throw error })
      automations.set(stores.projectDir, pending)
    }
    return pending
  }
  const routeOptions = { ...options, automationRuntime }
  const routers = new Map(spaces.map((space) => [spaceId(space), routes(connections,
    options.onSpaceAnswer ? (item) => options.onSpaceAnswer!(space.projectDir, item) : options.onAnswer, routeOptions,
    options.onSpaceLeadMention ? (id, message) => options.onSpaceLeadMention!(space.projectDir, id, message) : options.onLeadMention)]))
  let refreshedAt = Date.now()
  let refreshing: Promise<void> | undefined
  const refreshSpaces = async () => {
    refreshedAt = Date.now()
    const next = options.spacesDir ? await discoverSpaces(options.spacesDir) : await Promise.all(spaces.map(space => openProject(space.projectDir)))
    for (const space of next) if (!spaces.some(current => current.projectDir === space.projectDir)) await options.onSpaceLoad?.(space)
    for (const space of spaces) if (!next.some(current => current.projectDir === space.projectDir)) {
      const pending = automations.get(space.projectDir)
      if (pending) { await (await pending).close(); automations.delete(space.projectDir) }
      await options.onSpaceUnload?.(space.projectDir)
    }
    spaces = next
    byId.clear()
    for (const space of spaces) {
      byId.set(spaceId(space), space)
      if (!routers.has(spaceId(space))) routers.set(spaceId(space), routes(connections,
        options.onSpaceAnswer ? (item) => options.onSpaceAnswer!(space.projectDir, item) : options.onAnswer, routeOptions,
        options.onSpaceLeadMention ? (id, message) => options.onSpaceLeadMention!(space.projectDir, id, message) : options.onLeadMention))
    }
    for (const id of routers.keys()) if (!byId.has(id)) routers.delete(id)
  }
  const refresh = () => refreshing ??= refreshSpaces().finally(() => { refreshing = undefined })
  const admin = createRouter<Handler>()
  const modelSpaces = async () => (await Promise.all(spaces.map(space =>
    openProject(space.projectDir).catch(() => undefined)))).filter(space => space !== undefined)
  const adminDeps = { spacesDir: options.spacesDir, projectDir: options.projectDir, onChange: refresh }
  let stewardMcpUrl = ''
  const stewardOptions = { ...adminDeps, registry: byId, connections, mcpUrl: () => stewardMcpUrl,
    serverCommands: createServerCommandRegistry(adminDeps),
    prepareStores: async (stores: import('@taktflow/core').ProjectStores) => attachKnowledge(stores, options.spacesDir),
    commands: options.getCommands,
    onLeadMention: options.onSpaceLeadMention ?? (options.onLeadMention ? (_dir: string, id: string, message: Parameters<LeadMention>[1]) => options.onLeadMention!(id, message) : undefined),
    steward: { extraRisks: knowledgeRisks },
    resolveChat: async (prefs: import('@taktflow/core').StewardPrefs) => stewardModel(await modelSpaces(), prefs).chat,
  }
  const userService = (request: import('node:http').IncomingMessage) => {
    const by = actor(request, spaces[0])
    if (by.type !== 'human') throw new HttpError(403, '管家需要用户身份')
    try {
      const deps = createStewardDeps(stewardOptions, by.id)
      return { deps, store: new StewardStore(deps.dataDir(by.id)) }
    } catch (error) {
      if (error instanceof StewardError) throw new HttpError(error.status, error.message)
      throw error
    }
  }
  const serverRead: Handler = async ({ request }) => {
    const { store } = userService(request)
    return { ...serverInfo(adminDeps), steward: stewardModel(await modelSpaces(), await store.prefs()).info }
  }
  const spacesRead: Handler = async ({ request, url }) => {
    const { deps, store } = userService(request)
    const risks = Object.values(await store.read<Record<string, import('@taktflow/core').Risk>>('risks.json') ?? {})
    return (url.searchParams.get('archived') === '1' ? await listSpaces(adminDeps, true) : await Promise.all(spaces.map(spaceSummary))).map(space => ({ ...space, risks: risks.filter(r => r.spaceId === space.id && r.state === 'open').length }))
  }
  serverCrudRoutes(admin.add, adminDeps, { server: serverRead, spaces: spacesRead })
  const steward = registerStewardRoutes(admin, stewardOptions)
  let closing = false
  const server = httpServer((request, response) => {
    void (async () => {
      response.setHeader('vary', 'Origin')
      if (request.headers.origin === 'http://localhost:5173') {
        response.setHeader('access-control-allow-origin', 'http://localhost:5173')
        response.setHeader('access-control-allow-methods', 'GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS')
        response.setHeader('access-control-allow-headers', 'Content-Type, X-Takt-User, X-Takt-Reason, Last-Event-ID')
      }
      if (closing) throw new HttpError(500, '服务正在关闭')
      if (request.method === 'OPTIONS') { response.writeHead(204); response.end(); return }
      let url: URL
      try { url = new URL(request.url ?? '/', 'http://localhost') } catch { throw new HttpError(400, 'URL 不合法') }
      if (url.pathname.startsWith('/api/') && Date.now() - refreshedAt > 2000) await refresh()
      const adminRoute = admin.match(request.method ?? 'GET', url.pathname)
      if (adminRoute) {
        validateWriteRequest(request)
        const result = await adminRoute.handler({ stores: spaces[0]!, request, response, url, params: adminRoute.params })
        if (result !== STREAMING) json(response, result)
        return
      }
      let selected = spaces[0]
      const prefix = /^\/api\/s\/([^/]+)(?=\/|$)/.exec(url.pathname)
      if (prefix) {
        let id: string
        try { id = decodeURIComponent(prefix[1]!) } catch { throw new HttpError(400, '空间 ID 编码不合法') }
        const found = byId.get(id)
        if (!found) throw new HttpError(404, '空间不存在')
        selected = found
        url.pathname = '/api' + url.pathname.slice(prefix[0].length)
      }
      const scopedAdmin = prefix && admin.match(request.method ?? 'GET', url.pathname)
      if (scopedAdmin && url.pathname.startsWith('/api/steward/')) {
        validateWriteRequest(request)
        const result = await scopedAdmin.handler({ stores: selected!, request, response, url, params: scopedAdmin.params })
        if (result !== STREAMING) json(response, result)
        return
      }
      const matched = selected && routers.get(spaceId(selected))?.match(request.method ?? 'GET', url.pathname)
      if (matched) {
        validateWriteRequest(request)
        // openProject 的 config 是快照，按请求重新打开，CLI 修改配置和文件后即可读到。
        const fresh = await openProject(selected!.projectDir)
        attachKnowledge(fresh, options.spacesDir)
        attachLessons(fresh)
        attachCrudServices(fresh)
        rememberStores(fresh)
        if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method ?? '') && !url.pathname.startsWith('/api/commands/') && !/^\/api\/requirements\/[^/]+\/route$/.test(url.pathname) && url.pathname !== '/api/route/preview') authorize(request, fresh)
        const result = await matched.handler({ stores: fresh, request, response, url, params: matched.params })
        if (url.pathname === '/api/space' && request.method === 'GET') {
          const { deps, store } = userService(request)
          const risks = Object.values(await store.read<Record<string, import('@taktflow/core').Risk>>('risks.json') ?? {})
          Object.assign(result as object, { risks: risks.filter(r => r.spaceId === spaceId(fresh) && r.state === 'open').length })
        }
        if (result !== STREAMING) json(response, result)
        return
      }
      if (url.pathname === '/api' || url.pathname.startsWith('/api/')) throw new HttpError(404, 'API 路由不存在')
      if (request.method !== 'GET' && request.method !== 'HEAD') throw new HttpError(404, '路由不存在')
      await staticFile(options.webDir, url.pathname, response, request.method === 'HEAD')
    })().catch((error: unknown) => fail(response, error))
  })
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(options.port ?? 4870, options.host ?? '127.0.0.1', () => { server.off('error', reject); resolve() })
    })
  } catch (error) { await steward.close(); throw error }
  const maintenance = startMaintenance(() => spaces, (stores, item) => options.onSpaceAnswer ? options.onSpaceAnswer(stores.projectDir, item) : options.onAnswer?.(item))
  const address = server.address() as AddressInfo
  stewardMcpUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/steward/mcp`
  automationUrl = `http://${address.address.includes(':') ? `[${address.address}]` : address.address}:${address.port}`
  const syncAutomations = async () => {
    const dirs = new Set(spaces.map(s => s.projectDir))
    for (const [dir, pending] of automations) if (!dirs.has(dir)) { await (await pending).close(); automations.delete(dir); await options.onSpaceUnload?.(dir) }
    for (const space of spaces) await automationRuntime(space)
  }
  try { await syncAutomations() } catch (error) {
    await maintenance.close(); await steward.close()
    for (const pending of automations.values()) await (await pending).close()
    await new Promise<void>(resolve => server.close(() => resolve()))
    throw error
  }
  let automationRefresh: Promise<void> | undefined
  const automationScanner = setInterval(() => {
    if (closing || automationRefresh) return
    automationRefresh = refresh().then(syncAutomations).catch(() => { process.stderr.write('自动化空间刷新失败，请检查空间配置后重试\n') }).finally(() => { automationRefresh = undefined })
  }, 5000)
  automationScanner.unref()
  let closePromise: Promise<void> | undefined
  return {
    url: `http://${address.address.includes(':') ? `[${address.address}]` : address.address}:${address.port}`,
    close() {
      if (closePromise) return closePromise
      closing = true
      clearInterval(automationScanner)
      closePromise = Promise.all([automationRefresh, refreshing]).then(async () => { for (const pending of automations.values()) await (await pending).close() }).then(() => maintenance.close()).then(() => steward.close()).then(() => new Promise<void>((resolve, reject) => {
        for (const close of connections) close()
        server.close((error) => { if (error) reject(error); else resolve() })
        server.closeAllConnections()
      }))
      return closePromise
    },
  }
}

export { discoverSpaces, spaceSummary, spaceId, spaceDetail, workflowStore, repoManager, auditSpace, changeConfig, members, repoBinding, spaceFile, atomicWrite } from './space.js'
export type { LeadMention } from './space-routes.js'

export { projectCommands, attachCrudServices, patchConfig } from './space.js'
export { attachLessons, answerAttention, routingWorkflows } from './commands.js'
export type { M3Callbacks } from './m3-routes.js'

export * from './space-admin.js'
export { deleteRequirement } from './crud-routes.js'
export { convertWorkflow } from './workflow-routes.js'

export { attachKnowledge, configuredChat, stewardModel } from './knowledge-runtime.js'
export { registerStewardRoutes, createStewardDeps } from './steward-routes.js'
export { registerKnowledgeRoutes } from './knowledge-routes.js'

export { StewardMcp } from './steward-mcp.js'
export { stewardRuntime } from './steward-runtime.js'

export { sendToChannel } from './channel-delivery.js'
export { AutomationRuntime } from './automation-runtime.js'
