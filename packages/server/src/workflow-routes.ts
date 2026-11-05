import type { ApiCore, ReadOp, WriteOp } from './api-core.js'
import { actor, body, json, safeId } from './http.js'
import { apiParams, STREAMING, type Handler } from './routes.js'
import { liveStream } from './live-stream.js'

export function workflowRoutes(add: (method: string, path: string, handler: Handler) => void, connections: Set<() => void>, core: ApiCore) {
  const read = (op: ReadOp): Handler => (ctx) => core.read(ctx.stores, op, apiParams(ctx.url, ctx.params))
  const write = (op: WriteOp): Handler => async (ctx) => {
    const value = await core.write(ctx.stores, op, apiParams(ctx.url, ctx.params), () => body(ctx.request), actor(ctx.request))
    if (value && typeof value === 'object' && 'error' in value) { json(ctx.response, value, value.error === 'conflict' ? 409 : 400); return STREAMING }
    return value
  }
  add('GET', '/api/workflows', read('workflows'))
  add('GET', '/api/workflows/:id', read('workflow'))
  add('GET', '/api/workflows/:id/source', read('workflow.source'))
  add('PATCH', '/api/workflows/:id', write('workflow.edit'))
  add('PUT', '/api/workflows/:id/source', write('workflow.source.replace'))
  add('PUT', '/api/workflows/:id/layout', write('workflow.layout'))
  add('GET', '/api/workflows/:id/revisions', read('workflow.revisions'))
  add('GET', '/api/workflows/:id/revisions/:rev', read('workflow.revision'))
  add('POST', '/api/workflows/:id/rollback', write('workflow.rollback'))
  add('GET', '/api/workflows/:id/stream', async ({ stores, params, response }) => {
    await core.read(stores, 'workflow', { id: safeId(params.id!) })
    liveStream(response, connections, (send, fail) => {
      const unwatch = core.subscribeWorkflow(stores, params.id!, send, fail)
      return () => { void unwatch().catch(fail) }
    })
    return STREAMING
  })
}
