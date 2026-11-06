import type { RoomMessage } from '@taktflow/core'
import { queryParams, actor, body, jsonBody, integer } from './http.js'
import type { ApiCore, ReadOp, WriteOp } from './api-core.js'
import type { M3Callbacks } from './m3-routes.js'
import { streamEvents } from './stream.js'
import { STREAMING, type Handler } from './routes.js'

export type LeadMention = (requirementId: string, message: RoomMessage) => void | Promise<void>
export function spaceRoutes(add: (method: string, path: string, handler: Handler) => void, connections: Set<() => void>, core: ApiCore, options: M3Callbacks = {}) {
  const read = (op: ReadOp): Handler => ({ stores, params, url, request }) => core.read(stores, op, { ...queryParams(url), ...params }, actor(request, stores))
  const write = (op: WriteOp): Handler => ({ stores, params, url, request }) => core.write(stores, op, { ...queryParams(url), ...params }, async () => {
    if (op !== 'space.members' && op !== 'room.members') return body(request)
    const input = await jsonBody(request)
    return Array.isArray(input) ? { members: input, reason: request.headers['x-takt-reason'] } : input
  }, actor(request, stores))
  add('GET', '/api/space', read('space'))
  add('GET', '/api/space/files', read('space.file'))
  add('GET', '/api/requirements/:id/reviews', read('reviews'))
  add('GET', '/api/requirements/:id/room', read('room'))
  add('GET', '/api/requirements/:id/chat', read('chat'))
  add('PUT', '/api/space/members', write('space.members'))
  add('POST', '/api/space/repos', write('space.repo.add'))
  add('PATCH', '/api/space/repos/:repoId', write('space.repo.update'))
  add('POST', '/api/space/repos/:repoId/sync', write('space.repo.sync'))
  add('PUT', '/api/space/files', write('space.file.edit'))
  add('POST', '/api/requirements/:id/room/members', write('room.members'))
  add('POST', '/api/requirements/:id/chat', write('chat.send'))
  add('GET', '/api/requirements/:id/chat/stream', async ({ stores, params, request, response, url }) => {
    const cursor = url.searchParams.get('after') ?? (typeof request.headers['last-event-id'] === 'string' ? request.headers['last-event-id'] : null)
    const controller = new AbortController()
    response.once('close', () => controller.abort())
    const id = params.id!
    const events = core.chat(stores, id, integer(cursor, 'after'), controller.signal)
    await events.ready
    const streaming = streamEvents(events, controller, response, connections)
    // streamEvents 先写响应头；Lead presence 监听在流存活期间安装。
    await Promise.resolve()
    const send = (presence: import('@taktflow/core').LeadPresence) => { if (!response.destroyed) response.write(`event: lead\ndata: ${JSON.stringify(presence)}\n\n`) }
    const unsubscribe = options.subscribeLead?.(stores.projectDir, id, send)
    response.once('close', () => unsubscribe?.())
    send(options.getLeadPresence?.(stores.projectDir, id) ?? { state: 'idle', since: new Date().toISOString() })
    await streaming
    return STREAMING
  })
}
