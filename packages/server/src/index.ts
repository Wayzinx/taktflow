import { createServer as httpServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { openProject, type AttentionItem } from '@taktflow/core'
import { fail, HttpError, json } from './http.js'
import { routes, STREAMING } from './routes.js'
import { staticFile } from './static.js'

export interface ServerOptions {
  projectDir: string
  port?: number
  host?: string
  webDir?: string
  onAnswer?: (item: AttentionItem) => void | Promise<void>
}

export interface RunningServer { url: string; close(): Promise<void> }

export async function createServer(options: ServerOptions): Promise<RunningServer> {
  const stores = await openProject(options.projectDir)
  const connections = new Set<() => void>()
  const router = routes(connections, options.onAnswer)
  let closing = false
  const server = httpServer((request, response) => {
    void (async () => {
      response.setHeader('vary', 'Origin')
      if (request.headers.origin === 'http://localhost:5173') {
        response.setHeader('access-control-allow-origin', 'http://localhost:5173')
        response.setHeader('access-control-allow-methods', 'GET, HEAD, POST, PUT, OPTIONS')
        response.setHeader('access-control-allow-headers', 'Content-Type, X-Takt-User, Last-Event-ID')
      }
      if (closing) throw new HttpError(500, '服务正在关闭')
      if (request.method === 'OPTIONS') { response.writeHead(204); response.end(); return }
      let url: URL
      try { url = new URL(request.url ?? '/', 'http://localhost') } catch { throw new HttpError(400, 'URL 不合法') }
      const matched = router.match(request.method ?? 'GET', url.pathname)
      if (matched) {
        // openProject 的 config 是快照，按请求重新打开，CLI 修改配置和文件后即可读到。
        const fresh = await openProject(stores.projectDir)
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
