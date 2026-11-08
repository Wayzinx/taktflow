import { nodeChanges, nodeDiff, previewRewind, rewind, runTimeline, type InvocationStart } from '@taktflow/core'
import { actor, artifactPath, body, relativePath, text } from './http.js'
import { nodeDetail, run, workflow } from './read-model.js'
import type { Handler } from './routes.js'
import { qualityHandler } from './quality-routes.js'

export function runInsightRoutes(register: (method: string, path: string, handler: Handler) => void): void {
  const add: typeof register = (method, path, handler) => register(method, path, qualityHandler(handler))
  add('GET', '/api/runs/:runId/timeline', async ({ stores, params }) => {
    const state = await run(stores, params.runId!)
    const events = await stores.events.read(state.runId)
    const result = runTimeline(state, events, await workflow(stores, state.runId))
    const starts = new Map(events.filter(e => e.type === 'invocation.started').map(e => { const data = e.data as InvocationStart; return [data.id, data] }))
    for (const lane of result.lanes) for (const invocation of lane.invocations ?? []) {
      const start = starts.get(invocation.id)
      if (start) { invocation.attempt = start.attempt; invocation.fallbackIndex = start.fallbackIndex }
    }
    return result
  })
  const node = '/api/runs/:runId/nodes/:nodeId'
  const checked = (handler: Handler): Handler => async context => {
    await run(context.stores, context.params.runId!)
    relativePath(context.params.nodeId!)
    await nodeDetail(context.stores, context.params.runId!, context.params.nodeId!)
    return handler(context)
  }
  add('GET', `${node}/changes`, checked(({ stores, params }) => nodeChanges(stores, params.runId!, params.nodeId!)))
  add('GET', `${node}/diff`, checked(({ stores, params, url }) => nodeDiff(stores, params.runId!, params.nodeId!, url.searchParams.has('path') ? artifactPath(url.searchParams.get('path')) : undefined)))
  add('POST', `${node}/rewind/preview`, checked(({ stores, params }) => previewRewind(stores, params.runId!, params.nodeId!)))
  add('POST', `${node}/rewind`, checked(async ({ stores, params, request }) => {
    const input = await body(request)
    return rewind(stores, params.runId!, params.nodeId!, { token: text(input.token, 'token'), reason: text(input.reason, 'reason') }, actor(request, stores))
  }))
}
