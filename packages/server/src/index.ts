import type { WriteLease } from './api-core.js'
import { createServer as httpServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { openProject, type AttentionItem } from '@taktflow/core'
import { discoverSpaces, spaceId, spaceSummary } from './space.js'
import type { LeadMention } from './space-routes.js'
import type { CatalogCallbacks } from './catalog.js'
import { fail, HttpError, json } from './http.js'
import { routes, STREAMING } from './routes.js'
import { staticFile } from './static.js'

export interface ServerOptions extends CatalogCallbacks {
  withWriteLease?: WriteLease
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
  const spaces = options.spacesDir ? await discoverSpaces(options.spacesDir) : [await openProject(options.projectDir ?? process.cwd())]
  const stores = spaces[0]!
  const byId = new Map(spaces.map((space) => [spaceId(space), space]))
  const connections = new Set<() => void>()
  const routers = new Map(spaces.map((space) => [spaceId(space), routes(connections,
    options.onSpaceAnswer ? (item) => options.onSpaceAnswer!(space.projectDir, item) : options.onAnswer, options,
    options.onSpaceLeadMention ? (id, message) => options.onSpaceLeadMention!(space.projectDir, id, message) : options.onLeadMention, options.withWriteLease)]))
  let closing = false
  const server = httpServer((request, response) => {
    void (async () => {
      response.setHeader('vary', 'Origin')
      if (request.headers.origin === 'http://localhost:5173') {
        response.setHeader('access-control-allow-origin', 'http://localhost:5173')
        response.setHeader('access-control-allow-methods', 'GET, HEAD, POST, PUT, PATCH, OPTIONS')
        response.setHeader('access-control-allow-headers', 'Content-Type, X-Takt-User, X-Takt-Reason, Last-Event-ID')
      }
      if (closing) throw new HttpError(500, '服务正在关闭')
      if (request.method === 'OPTIONS') { response.writeHead(204); response.end(); return }
      let url: URL
      try { url = new URL(request.url ?? '/', 'http://localhost') } catch { throw new HttpError(400, 'URL 不合法') }
      let selected = stores
      const prefix = /^\/api\/s\/([^/]+)(?=\/|$)/.exec(url.pathname)
      if (prefix) {
        let id: string
        try { id = decodeURIComponent(prefix[1]!) } catch { throw new HttpError(400, '空间 ID 编码不合法') }
        const found = byId.get(id)
        if (!found) throw new HttpError(404, '空间不存在')
        selected = found
        url.pathname = '/api' + url.pathname.slice(prefix[0].length)
      }
      if (url.pathname === '/api/spaces' && request.method === 'GET') {
        json(response, await Promise.all(spaces.map(async (space) => spaceSummary(await openProject(space.projectDir)))))
        return
      }
      const matched = routers.get(spaceId(selected))!.match(request.method ?? 'GET', url.pathname)
      if (matched) {
        // openProject 的 config 是快照，按请求重新打开，CLI 修改配置和文件后即可读到。
        const fresh = await openProject(selected.projectDir)
        const result = await matched.handler({ stores: fresh, request, response, url, params: matched.params })
        if (result !== STREAMING) json(response, result)
        return
      }
      if (url.pathname === '/api' || url.pathname.startsWith('/api/')) throw new HttpError(404, 'API 路由不存在')
      if (request.method !== 'GET' && request.method !== 'HEAD') throw new HttpError(404, '路由不存在')
      await staticFile(options.webDir, url.pathname, response, request.method === 'HEAD')
    })().catch((error: unknown) => fail(response, error))
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(options.port ?? 4870, options.host ?? '127.0.0.1', () => { server.off('error', reject); resolve() })
  })
  const address = server.address() as AddressInfo
  let closePromise: Promise<void> | undefined
  return {
    url: `http://${address.address.includes(':') ? `[${address.address}]` : address.address}:${address.port}`,
    close() {
      if (closePromise) return closePromise
      closing = true
      closePromise = new Promise<void>((resolve, reject) => {
        for (const close of connections) close()
        server.close((error) => { if (error) reject(error); else resolve() })
        server.closeAllConnections()
      })
      return closePromise
    },
  }
}

export { discoverSpaces, spaceId, spaceSummary, spaceDetail, workflowStore, repoManager, auditSpace, changeConfig, members, repoBinding, spaceFile, atomicWrite } from './space.js'
export type { LeadMention } from './space-routes.js'

export { createApiCore, ApiError, type ApiCore, type ApiCoreOptions, type EventStream, type ReadOp, type WriteOp, type WriteLease } from './api-core.js'
export { watchQualityEvents } from './quality-feed.js'
