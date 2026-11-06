import { createApiCore } from './api-core.js'
import type { EvalRuntimeResolver, M3Callbacks } from './api-m3.js'
import type { ApiCore, ReadOp, WriteOp } from './api-core.js'
import { queryParams, actor, body } from './http.js'
import type { Handler } from './routes.js'
export type { EvalRuntimeResolver } from './api-m3.js'

export function registerEvalRoutes(add: (method: string, path: string, handler: Handler) => void, coreOrRuntime: ApiCore | EvalRuntimeResolver, options: M3Callbacks = {}): void {
  const core = typeof coreOrRuntime === 'function' ? createApiCore({ ...options, resolveRuntime: coreOrRuntime }) : coreOrRuntime
  const read = (op: ReadOp): Handler => ({ stores, params, url, request }) => core.read(stores, op, { ...queryParams(url), ...params }, actor(request, stores))
  const write = (op: WriteOp): Handler => ({ stores, params, request }) => core.write(stores, op, params, () => body(request, op === 'defect.attribute'), actor(request, stores))
  add('GET', '/api/eval/scorecards', read('eval.scorecards'))
  add('GET', '/api/eval/cases', read('eval.cases'))
  add('POST', '/api/eval/cases/collect', write('eval.collect'))
  add('GET', '/api/eval/runs', read('eval.runs'))
  add('GET', '/api/eval/runs/:id', read('eval.run'))
  add('GET', '/api/eval/runs/:id/output', read('eval.output'))
  add('POST', '/api/eval/runs', write('eval.run'))
  add('GET', '/api/requirements/:id/defects', read('defects'))
  add('POST', '/api/requirements/:id/defects', write('defect.report'))
  add('POST', '/api/requirements/:id/defects/:defectId/attribute', write('defect.attribute'))
  add('POST', '/api/requirements/:id/defects/:defectId/confirm', write('defect.confirm'))
}
