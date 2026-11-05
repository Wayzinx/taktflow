import type { ApiCore, ReadOp, WriteOp } from './api-core.js'
import { actor, body, jsonBody, integer } from './http.js'
import { requirement } from './read-model.js'
import { streamEvents } from './stream.js'
import { apiParams, STREAMING, type Handler } from './routes.js'
export type { LeadMention } from './api-space.js'

export function spaceRoutes(add: (method: string, path: string, handler: Handler) => void, connections: Set<() => void>, core: ApiCore) {
  const read = (op: ReadOp): Handler => (ctx) => core.read(ctx.stores, op, apiParams(ctx.url, ctx.params))
  const write = (op: WriteOp): Handler => (ctx) => core.write(ctx.stores, op, apiParams(ctx.url, ctx.params), async () => {
    if (op === 'space.members' || op === 'room.members') {
      const input = await jsonBody(ctx.request)
      return Array.isArray(input) ? { members: input, reason: ctx.request.headers['x-takt-reason'] } : input
    }
    return body(ctx.request)
  }, actor(ctx.request))
  add('GET', '/api/space', read('space'))
  add('PUT', '/api/space/members', write('space.members'))
  add('POST', '/api/space/repos', write('space.repo.add'))
  add('POST', '/api/space/repos/:repoId/sync', write('space.repo.sync'))
  add('GET', '/api/space/files', read('space.file'))
  add('PUT', '/api/space/files', write('space.file.edit'))
  add('GET', '/api/requirements/:id/reviews', read('reviews'))
  add('GET', '/api/requirements/:id/room', read('room'))
  add('POST', '/api/requirements/:id/room/members', write('room.members'))
  add('GET', '/api/requirements/:id/chat', read('chat'))
  add('POST', '/api/requirements/:id/chat', write('chat.send'))
  add('GET', '/api/requirements/:id/chat/stream', async ({ stores, params, request, response, url }) => {
    await requirement(stores, params.id!)
    const cursor = url.searchParams.get('after') ?? (typeof request.headers['last-event-id'] === 'string' ? request.headers['last-event-id'] : null)
    const controller = new AbortController()
    await streamEvents(core.chat(stores, params.id!, integer(cursor, 'after'), controller.signal), controller, response, connections)
    return STREAMING
  })
}
