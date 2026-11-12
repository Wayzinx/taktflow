import type { IncomingMessage } from 'node:http'
import { FsWorkspaceStore, requireRole, type ProjectStores } from '@taktflow/core'
import { actor, body, globalActor, HttpError, safeId, text } from './http.js'
import { attachCrudServices, auditSpace, projectCommands } from './space.js'
import { requirement, summary } from './read-model.js'
import { STREAMING, type Handler } from './routes.js'
import { commandExecutor, type M3Callbacks } from './m3-routes.js'
import { spaceLock } from './space-lock.js'
import { join } from 'node:path'
import { archiveSpace, createSpace, deleteSpace, listSpaces, restoreSpace, serverInfo, updateSpace, type ServerCommandDeps } from './space-admin.js'
import type { SpaceCreateRequest, SpaceUpdateRequest } from '@taktflow/core'

// 附件允许 20MB 解码内容，base64 加 JSON 包装最多约 28MB。
export const crudBody = (request: IncomingMessage) => body(request, false, 30 * 1024 * 1024)
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
  const { execute } = commandExecutor(options)
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
export function serverCrudRoutes(add: (method: string, path: string, handler: Handler) => void, deps: ServerCommandDeps, reads: { server?: Handler; spaces?: Handler } = {}): void {
  add('GET', '/api/server', reads.server ?? (() => serverInfo(deps)))
  add('GET', '/api/spaces', reads.spaces ?? (({ url }) => listSpaces(deps, url.searchParams.get('archived') === '1')))
  // 全局接口不属于任何空间：没选"我是"时按被操作的空间推断操作者（globalActor），不再一律当成 'web'
  add('POST', '/api/spaces', async ({ request, stores }) => {
    const input = await body(request)
    return createSpace(deps, input as unknown as SpaceCreateRequest, globalActor(request, stores))
  })
  add('PATCH', '/api/spaces/:id', async ({ request, params }) => updateSpace(deps, params.id!, await body(request) as unknown as SpaceUpdateRequest, globalActor(request)))
  add('POST', '/api/spaces/:id/archive', async ({ request, params }) => archiveSpace(deps, params.id!, globalActor(request), text((await body(request)).reason, 'reason')))
  add('POST', '/api/spaces/:id/restore', async ({ request, params }) => restoreSpace(deps, params.id!, globalActor(request), text((await body(request)).reason, 'reason')))
  add('DELETE', '/api/spaces/:id', async ({ request, response, params }) => {
    const input = await body(request)
    await deleteSpace(deps, params.id!, text(input.confirm, 'confirm'), globalActor(request), text(input.reason, 'reason'))
    response.writeHead(204); response.end(); return STREAMING
  })
}
