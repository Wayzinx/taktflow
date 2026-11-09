import { createServer, type Server, type ServerResponse } from 'node:http'
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { estimateTokens, resolveSecret as defaultResolveSecret, type ProviderBridge, type ProviderConfig, type ProviderProtocol } from '@taktflow/core'
import { endpoint, headers } from '../providers/http.js'
import { mapRequest, upstreamBody } from './request.js'
import { upstreamEvents, upstreamMessage } from './upstream.js'
import { downstream } from './downstream.js'
import type { Wire } from './wire.js'

interface Route { target: ProviderConfig; accept: ProviderProtocol; token: string; model?: string; controller: AbortController; dispose(): void }
export function createProviderBridge(options: { resolveSecret?: (name: string) => string | undefined; fetch?: typeof fetch; keepAliveMs?: number } = {}): ProviderBridge {
  const routes = new Map<string, Route>()
  let server: Server | undefined, starting: Promise<number> | undefined, closing: Promise<void> | undefined
  let generation = 0
  const resolveSecret = options.resolveSecret ?? defaultResolveSecret
  const supports: ProviderBridge['supports'] = (accept, upstream) => (accept === 'anthropic-messages' && upstream === 'openai-chat') || (accept === 'openai-responses' && ['openai-chat', 'anthropic-messages'].includes(upstream))
  const json = (res: ServerResponse, status: number, value: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)) }
  async function listen(): Promise<number> {
    if (closing) await closing
    if (starting) return starting
    server = createServer((req, res) => { void (async () => {
      const path = new URL(req.url ?? '/', 'http://localhost').pathname
      const match = /^\/r\/([^/]+)(\/.*)$/.exec(path), route = match && routes.get(match[1]!)
      if (!route) { json(res, 404, { error: { message: '路由不存在' } }); return }
      const anthropic = route.accept === 'anthropic-messages'
      const bearer = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? '')?.[1]
      const valid = [bearer, req.headers['x-api-key']].some(supplied => typeof supplied === 'string' && Buffer.byteLength(supplied) === Buffer.byteLength(route.token) && timingSafeEqual(Buffer.from(supplied), Buffer.from(route.token)))
      const error = (status: number, message: string, streaming = false) => {
        const e = { type: status === 401 ? 'authentication_error' : 'api_error', message, code: String(status) }
        if (streaming && !anthropic) {
          if (!res.headersSent) res.writeHead(status, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
          res.end(`event: response.failed\ndata: ${JSON.stringify({ type: 'response.failed', response: { id: `resp_${randomUUID()}`, object: 'response', status: 'failed', output: [], error: e }, error: e })}\n\n`)
        } else if (res.headersSent) res.end(`event: error\ndata: ${JSON.stringify({ type: 'error', error: e })}\n\n`)
        else json(res, status, anthropic ? { type: 'error', error: e } : { error: e })
      }
      if (!valid) { error(401, '桥接令牌无效'); return }
      if (!anthropic && req.method === 'GET' && match![2] === '/v1/models') { json(res, 200, { object: 'list', data: [{ id: route.model ?? '', object: 'model', owned_by: 'taktflow' }] }); return }
      const count = anthropic && match![2] === '/v1/messages/count_tokens'
      if (req.method !== 'POST' || !count && match![2] !== (anthropic ? '/v1/messages' : '/v1/responses')) { error(404, '接口不存在'); return }
      let body: Wire
      try {
        let raw = ''
        req.setEncoding('utf8')
        for await (const chunk of req) { raw += chunk.toString(); if (Buffer.byteLength(raw) > 32 * 1024 * 1024) throw new Error() }
        body = JSON.parse(raw)
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error()
      } catch { error(400, '请求 JSON 不合法或超过大小限制'); return }
      if (count) { json(res, 200, { input_tokens: estimateTokens(JSON.stringify({ system: body.system, messages: body.messages, tools: body.tools })) }); return }
      const streaming = body.stream === true
      const controller = new AbortController(), signal = AbortSignal.any([controller.signal, route.controller.signal])
      const disconnect = () => { if (!res.writableEnded) controller.abort() }
      res.once('close', disconnect)
      let timer: ReturnType<typeof setInterval> | undefined
      try {
        const key = route.target.apiKeyEnv ? resolveSecret(route.target.apiKeyEnv) : undefined
        if (route.target.apiKeyEnv && !key?.trim()) { error(401, `缺少密钥 ${route.target.apiKeyEnv}`, streaming); return }
        const mapped = mapRequest(body, anthropic), model = route.model ?? body.model
        const upstreamAnthropic = route.target.protocol === 'anthropic-messages'
        const payload = upstreamBody(mapped, model, upstreamAnthropic)
        const upstream = await (options.fetch ?? fetch)(endpoint(route.target, upstreamAnthropic ? 'anthropic-messages' : 'openai-chat'), {
          method: 'POST', headers: headers(route.target, route.target.protocol, () => key), body: JSON.stringify(payload), signal, redirect: 'manual',
        })
        if (!upstream.ok) {
          // 厂商的错误原因（模型不存在、余额不足、参数不支持……）原样带给 harness，密钥脱敏
          let detail: string | undefined
          try { const raw = (await upstream.text()).slice(0, 8192); try { detail = upstreamMessage(JSON.parse(raw)) } catch { detail = raw.trim().slice(0, 300) || undefined } } catch {}
          if (detail && key) detail = detail.split(key).join('[REDACTED]')
          error(upstream.status, `上游返回 HTTP ${upstream.status}${detail ? `：${detail}` : ''}`, streaming); return
        }
        if (streaming) res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
        const send = (type: string, data: Wire) => { if (streaming) res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`) }
        const output = downstream(anthropic, model, mapped.custom, send, mapped.namespaces)
        output.start()
        // 收到上游 HTTP 状态后才发送保活，以便认证与限流状态仍可原样透传。
        if (streaming) timer = setInterval(() => { res.write(anthropic ? 'event: ping\ndata: {"type":"ping"}\n\n' : ': keep-alive\n\n') }, options.keepAliveMs ?? 15_000)
        for await (const event of upstreamEvents(upstream, upstreamAnthropic)) output.event(event)
        const value = output.finish()
        if (streaming) res.end(); else json(res, 200, value)
      } catch (failure) {
        const message = failure instanceof Error && failure.message.startsWith('上游') ? failure.message : '上游请求失败或响应流中断'
        if (!res.destroyed) error(signal.aborted ? 499 : 502, signal.aborted ? '桥接请求已取消' : message, streaming)
      } finally { if (timer) clearInterval(timer); controller.abort(); res.off('close', disconnect) }
    })().catch(() => { if (!res.headersSent) json(res, 500, { error: { message: '协议桥请求处理失败' } }); else res.end() }) })
    const instance = server
    starting = new Promise<number>((resolve, reject) => {
      instance.once('error', reject)
      instance.listen(0, '127.0.0.1', () => { instance.off('error', reject); instance.unref(); resolve((instance.address() as { port: number }).port) })
    }).catch(error => { starting = undefined; server = undefined; throw error })
    return starting
  }
  return {
    supports,
    async open(target, accept, opts = {}) {
      if (!supports(accept, target.protocol)) throw new Error(`协议桥不支持 ${accept} ← ${target.protocol}`)
      opts.signal?.throwIfAborted()
      const openedGeneration = generation
      const port = await listen()
      if (generation !== openedGeneration) throw new Error('协议桥在打开路由时已关闭')
      const id = randomUUID(), token = randomBytes(32).toString('hex'), controller = new AbortController()
      const dispose = () => { routes.delete(id); controller.abort(); opts.signal?.removeEventListener('abort', dispose) }
      opts.signal?.addEventListener('abort', dispose, { once: true })
      routes.set(id, { target, accept, token, model: opts.model, controller, dispose })
      if (opts.signal?.aborted) { dispose(); opts.signal.throwIfAborted() }
      return { provider: { id: target.id, protocol: accept, baseURL: `http://127.0.0.1:${port}/r/${id}${accept === 'openai-responses' ? '/v1' : ''}`, apiKeyEnv: 'TAKT_BRIDGE_TOKEN' },
        env: { ...(target.apiKeyEnv && target.apiKeyEnv !== 'TAKT_BRIDGE_TOKEN' ? { [target.apiKeyEnv]: '' } : {}), TAKT_BRIDGE_TOKEN: token, NO_PROXY: [process.env.NO_PROXY, '127.0.0.1,localhost'].filter(Boolean).join(','), no_proxy: [process.env.no_proxy, '127.0.0.1,localhost'].filter(Boolean).join(',') }, close: async () => { dispose() } }
    },
    async close() {
      if (closing) return closing
      generation++
      closing = (async () => {
        await starting?.catch(() => {})
        for (const route of routes.values()) route.dispose()
        const instance = server; server = undefined; starting = undefined
        if (instance) await new Promise<void>((resolve, reject) => { instance.close(error => error ? reject(error) : resolve()); instance.closeAllConnections() })
      })()
      try { await closing } finally { closing = undefined }
    },
  }
}
