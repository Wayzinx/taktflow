import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Actor } from '@taktflow/core'
import { ApiError as HttpError } from './errors.js'
export { ApiError as HttpError } from './errors.js'
export { artifactPath, relativePath, runId, safeId, integer, text } from './validation.js'

export function json(response: ServerResponse, value: unknown, status = 200): void {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  response.end(JSON.stringify(value))
}

export function fail(response: ServerResponse, error: unknown): void {
  if (response.headersSent) { response.destroy(); return }
  json(response, { error: error instanceof HttpError ? error.message : '服务器内部错误', ...(error instanceof HttpError && error.detail !== undefined ? { detail: error.detail } : {}) }, error instanceof HttpError ? error.status : 500)
}

export function decode(value: string): string {
  try { return decodeURIComponent(value) } catch { throw new HttpError(400, 'URL 编码不合法') }
}

export async function jsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let length = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    length += buffer.length
    if (length > 8 * 1024 * 1024) throw new HttpError(400, '请求体过大')
    chunks.push(buffer)
  }
  let value: unknown
  try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { throw new HttpError(400, '请求体必须是合法 JSON') }
  return value
}

export async function body(request: IncomingMessage): Promise<Record<string, unknown>> {
  const value = await jsonBody(request)
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HttpError(400, '请求体必须是对象')
  return value as Record<string, unknown>
}

export function actor(request: IncomingMessage): Actor {
  const value = request.headers['x-takt-user']
  return { type: 'human', id: (Array.isArray(value) ? value[0] : value)?.trim() || 'web', via: 'web' }
}
