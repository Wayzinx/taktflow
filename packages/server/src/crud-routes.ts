import type { IncomingMessage } from 'node:http'
import { FsWorkspaceStore, requireRole, type ProjectStores } from '@taktflow/core'
import { actor, body, HttpError, safeId, text } from './http.js'
import { attachCrudServices, auditSpace, projectCommands } from './space.js'
import { requirement, summary } from './read-model.js'
import { STREAMING, type Handler } from './routes.js'
import type { M3Callbacks } from './m3-routes.js'
import { spaceLock } from './space-lock.js'
import { join } from 'node:path'
import { archiveSpace, createSpace, deleteSpace, listSpaces, restoreSpace, serverInfo, updateSpace, type ServerCommandDeps } from './space-admin.js'
import type { SpaceCreateRequest, SpaceUpdateRequest } from '@taktflow/core'

// 附件允许 20MB 解码内容，base64 加 JSON 包装最多约 28MB。
export async function crudBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []; let length = 0
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    length += bytes.length
    if (length > 30 * 1024 * 1024) throw new HttpError(400, '请求体过大，附件总量不得超过 20MB')
    chunks.push(bytes)
  }
  let value: unknown
  try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { throw new HttpError(400, '请求体必须是合法 JSON') }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HttpError(400, '请求体必须是对象')
  return value as Record<string, unknown>
}
export async function deleteRequirement(stores: ProjectStores, id: string, author: ReturnType<typeof actor>, reason: string): Promise<{ deleted: string }> {
  safeId(id); text(reason, 'reason')
  requireRole(stores, author, 'member', 'requirement.delete')
  return spaceLock(join(stores.taktDir, `crud-${id}`), async () => {
    await requirement(stores, id)
    if ((await stores.runs.list({ requirementId: id })).length) throw new HttpError(409, '需求已有运行记录，只能归档')
    await auditSpace(stores, author, reason, `requirement.delete ${id}`)
    await new FsWorkspaceStore(stores.taktDir, stores.paths.requirements, stores.chat).deleteRequirement(id)
    return { deleted: id }
  })
}
export function crudRoutes(add: (method: string, path: string, handler: Handler) => void, options: M3Callbacks): void {
  const execute = async (stores: ProjectStores, request: IncomingMessage, id: string, input: Record<string, unknown>, reason?: string) => {
    attachCrudServices(stores)
    const commands = id === 'requirement.create' ? projectCommands(stores, options.getCommands ? { startRun: async (input, context) => {
      const runtime = await options.getCommands!(stores)
      const response = await runtime.run('run.start', Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined)), context)
      if (!response.ok) throw new Error(response.message)
      return response.result
    } } : {}) : await options.getCommands?.(stores) ?? projectCommands(stores)
    const result = await commands.run(id, input, { actor: actor(request, stores), reason })
    if (!result.ok) throw new HttpError(/权限不足|必须由人/.test(result.message) ? 403 : /先取消运行|已有运行|已变化|冲突/.test(result.message) ? 409 : /不存在/.test(result.message) ? 404 : 400, result.message)
    return result.result
  }
  add('POST', '/api/commands/requirement.create', async ({ stores, request }) => {
    const input = await crudBody(request)
    if (!input.input || typeof input.input !== 'object' || Array.isArray(input.input)) throw new HttpError(400, 'input 必须是对象')
    try { return { ok: true, message: '创建需求已执行', result: await execute(stores, request, 'requirement.create', input.input as Record<string, unknown>, input.reason === undefined ? undefined : text(input.reason, 'reason', true)) } }
    catch (error) { return { ok: false, message: error instanceof Error ? error.message : String(error) } }
  })
  add('POST', '/api/requirements', async ({ stores, request }) => {
    const input = await crudBody(request)
    return execute(stores, request, 'requirement.create', input)
  })
  add('PATCH', '/api/requirements/:id', async ({ stores, request, params }) => {
    const input = await body(request)
    await requirement(stores, params.id!)
    await execute(stores, request, 'requirement.update', { ...input, requirementId: params.id }, text(input.reason, 'reason'))
    return summary(stores, await requirement(stores, params.id!))
  })
  for (const action of ['archive', 'restore']) add('POST', `/api/requirements/:id/${action}`, async ({ stores, request, params }) => {
    const input = await body(request)
    await requirement(stores, params.id!)
    await execute(stores, request, `requirement.${action}`, { requirementId: params.id }, text(input.reason, 'reason'))
    return summary(stores, await requirement(stores, params.id!))
  })
  add('DELETE', '/api/requirements/:id', async ({ stores, request, response, params }) => {
    const input = await body(request)
    await deleteRequirement(stores, params.id!, actor(request, stores), text(input.reason, 'reason'))
    response.writeHead(204); response.end(); return STREAMING
  })
}
export function serverCrudRoutes(add: (method: string, path: string, handler: Handler) => void, deps: ServerCommandDeps): void {
  add('GET', '/api/server', () => serverInfo(deps))
  add('GET', '/api/spaces', ({ url }) => listSpaces(deps, url.searchParams.get('archived') === '1'))
  add('POST', '/api/spaces', async ({ request }) => {
    const input = await body(request)
    return createSpace(deps, input as unknown as SpaceCreateRequest, actor(request))
  })
  add('PATCH', '/api/spaces/:id', async ({ request, params }) => updateSpace(deps, params.id!, await body(request) as unknown as SpaceUpdateRequest, actor(request)))
  add('POST', '/api/spaces/:id/archive', async ({ request, params }) => archiveSpace(deps, params.id!, actor(request), text((await body(request)).reason, 'reason')))
  add('POST', '/api/spaces/:id/restore', async ({ request, params }) => restoreSpace(deps, params.id!, actor(request), text((await body(request)).reason, 'reason')))
  add('DELETE', '/api/spaces/:id', async ({ request, response, params }) => {
    const input = await body(request)
    await deleteSpace(deps, params.id!, text(input.confirm, 'confirm'), actor(request), text(input.reason, 'reason'))
    response.writeHead(204); response.end(); return STREAMING
  })
}
