import type { IncomingMessage, ServerResponse } from 'node:http'
import type { AttentionItem, ProjectStores } from '@taktflow/core'
import { queryParams, actor, body, integer } from './http.js'
import type { CatalogCallbacks } from './catalog.js'
import { m3Routes, type M3Callbacks } from './m3-routes.js'
import { registerEvalRoutes } from './eval-routes.js'
import { createRouter } from './router.js'
import { createApiCore, type ReadOp, type WriteOp, type WriteLease, type EventStream } from './api-core.js'
import { streamEvents } from './stream.js'
import { spaceRoutes, type LeadMention } from './space-routes.js'
import { workflowRoutes } from './workflow-routes.js'

export interface RequestContext {
  stores: ProjectStores
  request: IncomingMessage
  response: ServerResponse
  url: URL
  params: Record<string, string>
}

export type Handler = (context: RequestContext) => Promise<unknown> | unknown
export const STREAMING = Symbol('streaming')

export function routes(connections: Set<() => void>, onAnswer?: (item: AttentionItem) => void | Promise<void>, catalog: CatalogCallbacks & M3Callbacks = {}, onLeadMention?: LeadMention, withWriteLease?: WriteLease) {
  const router = createRouter<Handler>()
  const add = router.add
  const core = createApiCore({ ...catalog, onAnswer, catalog, onLeadMention, withWriteLease })
  const read = (op: ReadOp): Handler => ({ stores, params, url, request }) => core.read(stores, op, { ...queryParams(url), ...params }, actor(request, stores))
  const write = (op: WriteOp): Handler => ({ stores, params, url, request }) => core.write(stores, op, { ...queryParams(url), ...params }, () => body(request), actor(request, stores))
  spaceRoutes(add, connections, core, catalog)
  m3Routes(add, core)
  registerEvalRoutes(add, core)
  workflowRoutes(add, connections, core)
  add('GET', '/api/project', read('project'))
  add('GET', '/api/requirements', read('requirements'))
  add('GET', '/api/requirements/:id', read('requirement'))
  add('GET', '/api/requirements/:id/artifacts', read('artifacts'))
  add('GET', '/api/requirements/:id/artifact', read('artifact'))
  add('GET', '/api/requirements/:id/comments', read('comments'))
  add('GET', '/api/requirements/:id/trace', read('trace'))
  add('GET', '/api/requirements/:id/metrics', read('metrics'))
  add('GET', '/api/runs', read('runs'))
  add('GET', '/api/runs/:runId', read('run'))
  add('GET', '/api/runs/:runId/events', read('events'))
  add('GET', '/api/runs/:runId/nodes/:nodeId', read('node'))
  add('GET', '/api/runs/:runId/audit', read('audit'))
  add('GET', '/api/attention', read('attention'))
  add('GET', '/api/harnesses', read('harnesses'))
  add('GET', '/api/models', read('models'))
  add('PUT', '/api/requirements/:id/artifact', write('artifact.edit'))
  add('POST', '/api/requirements/:id/comments', write('comment.add'))
  add('POST', '/api/attention/:requestId', write('attention.answer'))
  add('GET', '/api/runs/:runId/stream', async ({ stores, params, url, response, request }) => {
    const cursor = url.searchParams.get('after') ?? (typeof request.headers['last-event-id'] === 'string' ? request.headers['last-event-id'] : null)
    const controller = new AbortController()
    response.once('close', () => controller.abort())
    const events = core.events(stores, params.runId!, integer(cursor, 'after'), controller.signal) as EventStream
    await streamEvents(events, controller, response, connections)
    return STREAMING
  })
  return router
}
