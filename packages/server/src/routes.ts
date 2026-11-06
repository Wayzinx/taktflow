import type { IncomingMessage, ServerResponse } from 'node:http'
import type { AttentionItem, ProjectStores } from '@taktflow/core'
import { createApiCore, type EventStream, type ReadOp, type WriteLease, type WriteOp } from './api-core.js'
import type { CatalogCallbacks } from './catalog.js'
import { actor, body, integer } from './http.js'
import { run } from './read-model.js'
import { createRouter } from './router.js'
import { spaceRoutes, type LeadMention } from './space-routes.js'
import { workflowRoutes } from './workflow-routes.js'
import { streamEvents } from './stream.js'

export interface RequestContext {
  stores: ProjectStores
  request: IncomingMessage
  response: ServerResponse
  url: URL
  params: Record<string, string>
}

export type Handler = (context: RequestContext) => Promise<unknown> | unknown
export const STREAMING = Symbol('streaming')

/** 查询参数取第一个值（与 URLSearchParams.get 一致）；路由路径参数优先于同名查询参数。 */
export function apiParams(url: URL, path: Record<string, string>): Record<string, string | undefined> {
  const result = Object.create(null) as Record<string, string | undefined>
  for (const [key, value] of url.searchParams) if (!Object.hasOwn(result, key)) result[key] = value
  return Object.assign(result, path)
}

export function routes(connections: Set<() => void>, onAnswer?: (item: AttentionItem) => void | Promise<void>, catalog: CatalogCallbacks = {}, onLeadMention?: LeadMention, withWriteLease?: WriteLease) {
  const core = createApiCore({ onAnswer, catalog, onLeadMention, withWriteLease })
  const router = createRouter<Handler>()
  const add = router.add
  const read = (op: ReadOp) => (context: RequestContext) => core.read(context.stores, op, apiParams(context.url, context.params))
  const write = (op: WriteOp) => (context: RequestContext) => core.write(
    context.stores, op, apiParams(context.url, context.params), () => body(context.request), actor(context.request),
  )

  spaceRoutes(add, connections, core)
  workflowRoutes(add, connections, core)
  add('GET', '/api/quality/defects', read('quality.defects'))
  add('GET', '/api/quality/defects/:id', read('quality.defect'))
  add('POST', '/api/quality/defects', write('defect.create'))
  add('PATCH', '/api/quality/defects/:id', write('defect.update'))
  add('GET', '/api/quality/observations', read('quality.observations'))
  add('GET', '/api/quality/invocations/:invocationId', read('quality.invocation'))
  add('GET', '/api/quality/checkpoints/:checkpointId', read('quality.checkpoint'))
  add('GET', '/api/quality/defects/:defectId/attribution/candidates', read('quality.attribution.candidates'))
  add('POST', '/api/quality/defects/:defectId/attribution', write('attribution.record'))
  add('GET', '/api/quality/evalcases', read('quality.evalcases'))
  add('POST', '/api/quality/evalcases', write('evalcase.add'))
  add('PATCH', '/api/quality/evalcases/:id', write('evalcase.update'))
  add('GET', '/api/quality/candidates', read('quality.candidates'))
  add('POST', '/api/quality/candidates', write('candidate.create'))
  add('GET', '/api/quality/evals', read('quality.evals'))
  add('GET', '/api/quality/evals/:evalId', read('quality.eval'))
  add('POST', '/api/quality/evals', write('eval.start'))
  add('GET', '/api/project', read('project'))
  add('GET', '/api/requirements', read('requirements'))
  add('GET', '/api/requirements/:id', read('requirement'))
  add('GET', '/api/requirements/:id/artifacts', read('artifacts'))
  add('GET', '/api/requirements/:id/artifact', read('artifact'))
  add('PUT', '/api/requirements/:id/artifact', write('artifact.edit'))
  add('GET', '/api/requirements/:id/comments', read('comments'))
  add('POST', '/api/requirements/:id/comments', write('comment.add'))
  add('GET', '/api/requirements/:id/trace', read('trace'))
  add('GET', '/api/requirements/:id/metrics', read('metrics'))
  add('GET', '/api/runs', read('runs'))
  add('GET', '/api/runs/:runId', read('run'))
  add('GET', '/api/runs/:runId/events', read('events'))
  add('GET', '/api/runs/:runId/stream', async ({ stores, params: path, url, response, request }) => {
    await run(stores, path.runId!)
    const cursor = url.searchParams.get('after') ?? (typeof request.headers['last-event-id'] === 'string' ? request.headers['last-event-id'] : null)
    const after = integer(cursor, 'after') ?? 0
    const controller = new AbortController()
    const events = core.events(stores, path.runId!, after, controller.signal) as EventStream
    await streamEvents(events, controller, response, connections)
    return STREAMING
  })
  add('GET', '/api/runs/:runId/nodes/:nodeId', read('node'))
  add('GET', '/api/runs/:runId/audit', read('audit'))
  add('GET', '/api/attention', read('attention'))
  add('POST', '/api/attention/:requestId', write('attention.answer'))
  add('GET', '/api/harnesses', read('harnesses'))
  add('GET', '/api/models', read('models'))
  return router
}
