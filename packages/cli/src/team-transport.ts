import { Agent as HttpAgent, request as httpRequest, type IncomingMessage } from 'node:http'
import { Agent as HttpsAgent, request as httpsRequest } from 'node:https'
import { UsageError } from './args.js'

export interface TeamDestination { hub: string; space: string; node: string }
export const REQUEST_MS = 4000
const REPLY_BYTES = 400 * 1024
const httpAgent = new HttpAgent({ keepAlive: true })
const httpsAgent = new HttpsAgent({ keepAlive: true, rejectUnauthorized: true })

export class RemoteError extends Error {
  constructor(readonly status: number, action: string) { super(`Team Worker ${action} 失败（HTTP ${status}）`) }
  get retryable(): boolean { return this.status === 408 || this.status === 429 || this.status >= 500 }
}

export const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
export const teamId = (value: string) => /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)
export const validToken = (token: string) => /^[A-Za-z0-9_-]{32,256}$/.test(token)

export function teamEndpoint({ hub, space, node }: TeamDestination): URL {
  if (!/^https?:\/\/[^/]+/i.test(hub) || /[\x00-\x20\x7f\\?#]/.test(hub)) {
    throw new UsageError('--hub 必须是无 query 或 fragment 的 HTTP(S) URL')
  }
  let url: URL
  try { url = new URL(hub) } catch { throw new UsageError('--hub 必须是 HTTP(S) URL') }
  const loopback = url.hostname === '127.0.0.1' || url.hostname === '[::1]'
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) || /^https?:\/\/[^/]*@/i.test(hub)) {
    throw new UsageError('--hub 必须用 HTTPS，或使用指向本机隧道的 HTTP（127.0.0.1 / [::1]），且不含凭据')
  }
  if (url.protocol === 'https:' && process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0') throw new UsageError('Team Worker 要求启用 TLS 证书验证')
  if (!teamId(space) || !teamId(node)) throw new UsageError('空间或节点 ID 不合法')
  url.pathname = `${url.pathname.replace(/\/$/, '')}/api/team-worker/v1/${space}/${node}/`
  return url
}

export async function postTeamJson(
  url: URL, action: string, payload: object,
  { token, signal, timeout = REQUEST_MS }: { token?: string; signal?: AbortSignal; timeout?: number },
): Promise<unknown> {
  const requestTimeout = AbortSignal.timeout(timeout)
  const combined = signal ? AbortSignal.any([signal, requestTimeout]) : requestTimeout
  const target = new URL(action, url)
  const secure = target.protocol === 'https:'
  const body = JSON.stringify(payload)
  let response: IncomingMessage
  try {
    response = await new Promise<IncomingMessage>((resolve, reject) => {
      const request = (secure ? httpsRequest : httpRequest)(target,
        { method: 'POST', agent: secure ? httpsAgent : httpAgent, signal: combined }, resolve)
      request.once('error', reject)
      request.setHeader('content-type', 'application/json')
      request.setHeader('content-length', Buffer.byteLength(body))
      if (token !== undefined) request.setHeader('authorization', `Bearer ${token}`)
      request.end(body)
    })
  } catch { throw new RemoteError(503, action) }
  const status = response.statusCode ?? 503
  if (status < 200 || status >= 300) {
    response.destroy()
    throw new RemoteError(status, action)
  }
  return readReply(response, action)
}

async function readReply(response: IncomingMessage, action: string): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  try {
    for await (const chunk of response as AsyncIterable<Buffer>) {
      size += chunk.length
      if (size > REPLY_BYTES) break
      chunks.push(chunk)
    }
  } catch { throw new RemoteError(503, action) }
  if (size > REPLY_BYTES) throw new Error('Team Worker 响应过大')
  try { return JSON.parse(Buffer.concat(chunks, size).toString('utf8')) as unknown }
  catch { throw new Error(`Team Worker ${action} 响应不是 JSON`) }
}
