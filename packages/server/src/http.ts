import { QualityConflictError, RewindConflictError, requireRole, type SpaceMember } from '@taktflow/core'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { assertArtifactPath, assertNodeId, assertRequirementId, assertRunId, type Actor, type ProjectStores, type Viewer } from '@taktflow/core'
import { sendBody } from './static.js'

export class HttpError extends Error {
  constructor(readonly status: number, message: string) { super(message) }
}

export function json(response: ServerResponse, value: unknown, status = 200): void {
  sendBody(response, status, { 'content-type': 'application/json; charset=utf-8' }, JSON.stringify(value) ?? '')
}

export function fail(response: ServerResponse, error: unknown): void {
  if (error instanceof QualityConflictError || error instanceof RewindConflictError) error = new HttpError(409, error.message)
  if (response.headersSent) { response.destroy(); return }
  json(response, { error: error instanceof HttpError ? error.message : '服务器内部错误' }, error instanceof HttpError ? error.status : 500)
}

export function decode(value: string): string {
  try { return decodeURIComponent(value) } catch { throw new HttpError(400, 'URL 编码不合法') }
}

function validated(value: unknown, validate: (value: string) => string): string {
  if (typeof value !== 'string') throw new HttpError(400, '必须提供字符串路径或 ID')
  try { return validate(value) } catch (error) {
    throw new HttpError(400, error instanceof Error ? error.message : String(error))
  }
}

export const safeId = (value: string): string => validated(value, assertRequirementId)
export const runId = (value: string): string => validated(value, assertRunId)
export const relativePath = (value: unknown): string => validated(value, assertNodeId)

export const artifactPath = (value: unknown): string => validated(value, assertArtifactPath)

export function integer(value: string | null, name: string, min = 0): number | undefined {
  if (value === null) return undefined
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < min) throw new HttpError(400, `${name} 不合法`)
  return Number(value)
}

export function text(value: unknown, name: string, empty = false): string {
  if (typeof value !== 'string' || (!empty && !value.trim())) throw new HttpError(400, `${name} 必须是${empty ? '' : '非空'}字符串`)
  return value
}

export async function jsonBody(request: IncomingMessage, allowEmpty = false, limit = 8 * 1024 * 1024): Promise<unknown> {
  const chunks: Buffer[] = []
  let length = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    length += buffer.length
    if (length > limit) throw new HttpError(400, '请求体过大')
    chunks.push(buffer)
  }
  if (allowEmpty && length === 0) return {}
  let value: unknown
  try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { throw new HttpError(400, '请求体必须是合法 JSON') }
  return value
}

export async function body(request: IncomingMessage, allowEmpty = false, limit = 8 * 1024 * 1024): Promise<Record<string, unknown>> {
  const value = await jsonBody(request, allowEmpty, limit)
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
