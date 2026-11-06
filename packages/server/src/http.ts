import { requireRole, type SpaceMember } from '@taktflow/core'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Actor, ProjectStores, Viewer } from '@taktflow/core'

import { ApiError as HttpError } from './errors.js'
export { ApiError as HttpError } from './errors.js'
export { safeId, runId, relativePath, artifactPath, integer, text } from './validation.js'

export function json(response: ServerResponse, value: unknown, status = 200): void {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  response.end(JSON.stringify(value))
}

export function fail(response: ServerResponse, error: unknown): void {
  if (response.headersSent) { response.destroy(); return }
  json(response, { error: error instanceof HttpError ? error.message : '服务器内部错误' }, error instanceof HttpError ? error.status : 500)
}

export function decode(value: string): string {
  try { return decodeURIComponent(value) } catch { throw new HttpError(400, 'URL 编码不合法') }
}

export async function jsonBody(request: IncomingMessage, allowEmpty = false): Promise<unknown> {
  const chunks: Buffer[] = []
  let length = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    length += buffer.length
    if (length > 8 * 1024 * 1024) throw new HttpError(400, '请求体过大')
    chunks.push(buffer)
  }
  if (allowEmpty && length === 0) return {}
  let value: unknown
  try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { throw new HttpError(400, '请求体必须是合法 JSON') }
  return value
}

export async function body(request: IncomingMessage, allowEmpty = false): Promise<Record<string, unknown>> {
  const value = await jsonBody(request, allowEmpty)
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HttpError(400, '请求体必须是对象')
  return value as Record<string, unknown>
}

export function actor(request: IncomingMessage, stores?: ProjectStores): Actor {
  const value = request.headers['x-takt-user']
  return { type: 'human', id: (Array.isArray(value) ? value[0] : value)?.trim() || stores?.config.members?.find((member) => member.role === 'owner')?.id || 'web' }
}

export function viewer(request: IncomingMessage, stores: ProjectStores): Viewer {
  const id = (actor(request, stores) as Extract<Actor, { type: 'human' }>).id
  const member = stores.config.members?.length ? stores.config.members.find((member) => member.id === id)
    : { id, name: id, role: 'owner' as const }
  return { id, name: member?.name ?? id, member }
}

export function authorize(request: IncomingMessage, stores: ProjectStores, minRole: SpaceMember['role'] = 'member'): void {
  try { requireRole(stores, actor(request, stores), minRole, request.url ?? 'HTTP 写操作') }
  catch (error) { throw new HttpError(403, error instanceof Error ? error.message : String(error)) }
}

export function validateWriteRequest(request: IncomingMessage): void {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method ?? '')) return
  const origin = request.headers.origin
  const sameOrigin = `http://${request.headers.host}`
  if (origin && origin !== sameOrigin && origin !== 'http://localhost:5173') throw new HttpError(403, '请求来源不允许')
  if (request.headers['content-type']?.split(';')[0]?.trim().toLowerCase() !== 'application/json') throw new HttpError(415, '写请求必须使用 application/json')
}

export function queryParams(url: URL): Record<string, string> {
  return Object.fromEntries([...new Set(url.searchParams.keys())].map((key) => [key, url.searchParams.get(key)!]))
}
