import { QualityConflictError, RewindConflictError, requireRole, type SpaceMember } from '@taktflow/core'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { assertArtifactPath, assertNodeId, assertRequirementId, assertRunId, type Actor, type ProjectStores, type Viewer } from '@taktflow/core'

export class HttpError extends Error {
  constructor(readonly status: number, message: string) { super(message) }
}

export function json(response: ServerResponse, value: unknown, status = 200): void {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  response.end(JSON.stringify(value))
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

/** 请求头 x-takt-user：界面上选了"我是"才有；没选时为空，由调用方按所操作的空间回落到它的第一个 owner。 */
export function requestUser(request: IncomingMessage): string | undefined {
  const value = request.headers['x-takt-user']
  return (Array.isArray(value) ? value[0] : value)?.trim() || undefined
}

const firstOwner = (stores?: Pick<ProjectStores, 'config'>) => stores?.config.members?.find((member) => member.role === 'owner' && member.id !== 'web')?.id

export function actor(request: IncomingMessage, stores?: Pick<ProjectStores, 'config'>): Actor {
  return { type: 'human', id: requestUser(request) || firstOwner(stores) || 'web' }
}

/**
 * 全局接口（/api/spaces…）的操作者：请求头给了身份就是那个人；没给时返回函数，按被操作的空间推断，
 * 和空间内接口没选身份时取第一个 owner 一致（space 不给时用缺省空间）。推断不出时为 undefined，不冒充成员。
 */
export function globalActor(request: IncomingMessage, fallback?: ProjectStores): Actor | ((space?: Pick<ProjectStores, 'config'>) => Actor | undefined) {
  if (requestUser(request)) return actor(request)
  return (space) => {
    const id = firstOwner(space ?? fallback)
    return id ? { type: 'human', id } : undefined
  }
}

export function viewer(request: IncomingMessage, stores: ProjectStores): Viewer {
  const id = (actor(request, stores) as Extract<Actor, { type: 'human' }>).id
  const member = id === 'web' && (stores.config.members?.length || requestUser(request)) ? undefined : stores.config.members?.length ? stores.config.members.find((member) => member.id === id)
    : { id, name: id, role: 'owner' as const }
  return { id, name: member?.name ?? id, member }
}

/** 权限不足时说清楚：做什么需要哪个角色，你是谁、现在是什么角色（不写路由路径或命令名）。 */
export function roleDenied(stores: Pick<ProjectStores, 'config'>, by: Actor, minRole: SpaceMember['role'], what: string, where = '本空间'): HttpError {
  const id = by.type === 'human' ? by.id : by.type === 'agent' ? by.role : by.id
  const role = stores.config.members?.find((member) => member.id === id)?.role
  return new HttpError(403, `权限不足：${what}需要 ${minRole} 或更高角色，你（${id}）${role ? `在${where}是 ${role}${role === 'viewer' ? '（只读）' : ''}` : `不是${where}的成员`}`)
}

export function authorize(request: IncomingMessage, stores: ProjectStores, minRole: SpaceMember['role'] = 'member', what = '修改'): void {
  const by = actor(request, stores)
  // 没配置成员的旧式本地项目保持开放；有成员表时匿名身份没有权限。显式 web 由写请求入口统一拒绝。
  if (by.type === 'human' && by.id === 'web' && (stores.config.members?.length || requestUser(request))) throw new HttpError(403, '匿名身份 web 不能修改空间，请选择真实成员身份')
  try { requireRole(stores, by, minRole, what) } catch { throw roleDenied(stores, by, minRole, what) }
}

type RouteRole = 'maintainer' | 'owner'
const routeRoles = new WeakMap<object, { role: RouteRole; what: string }>()

/**
 * 路由声明自己需要的角色：处理前先校验；index.ts 的写操作兜底校验也按它报错，
 * 否则 viewer 改成员会先被兜底的 member 拦下，看到"需要 member"，升级后才发现其实要 owner。
 */
export function requires<C extends { request: IncomingMessage; stores: ProjectStores }, R>(role: RouteRole, what: string, handler: (context: C) => R): (context: C) => R {
  const guarded = (context: C) => { authorize(context.request, context.stores, role, what); return handler(context) }
  routeRoles.set(guarded, { role, what })
  return guarded
}

export const routeRole = (handler: object) => routeRoles.get(handler)

export function validateWriteRequest(request: IncomingMessage): void {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method ?? '')) return
  if (requestUser(request) === 'web') throw new HttpError(403, '匿名身份 web 不能执行写操作，请选择真实成员身份')
  const origin = request.headers.origin
  const sameOrigin = `http://${request.headers.host}`
  if (origin && origin !== sameOrigin && origin !== 'http://localhost:5173') throw new HttpError(403, '请求来源不允许')
  if (request.headers['content-type']?.split(';')[0]?.trim().toLowerCase() !== 'application/json') throw new HttpError(415, '写请求必须使用 application/json')
}
