import type { ApiCore, ReadOp, WriteOp } from './api-core.js'
import { queryParams, actor, body } from './http.js'
import type { Handler } from './routes.js'
export type { M3Callbacks } from './api-m3.js'

export function m3Routes(add: (method: string, path: string, handler: Handler) => void, core: ApiCore) {
  const read = (op: ReadOp): Handler => ({ stores, params, url, request }) => core.read(stores, op, { ...queryParams(url), ...params }, actor(request, stores))
  const write = (op: WriteOp): Handler => ({ stores, params, request }) => core.write(stores, op, params, () => body(request), actor(request, stores))
  add('GET', '/api/me', read('me'))
  add('GET', '/api/commands', read('commands'))
  add('POST', '/api/commands/:id', write('command.run'))
  add('POST', '/api/requirements/:id/route', write('route.preview'))
  add('GET', '/api/lessons', read('lessons'))
  add('PATCH', '/api/lessons/:id', write('lesson.update'))
  add('POST', '/api/runs/:runId/nodes/:nodeId/dispositions', write('review.dispose'))
}
