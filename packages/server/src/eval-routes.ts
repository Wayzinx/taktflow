import {
  getEvalRun, getEvalOutput, listDefects, listEvalCases, listEvalRuns, parseEvalTarget, scorecards,
  type EngineDeps, type ProjectStores, type ScorecardOptions,
} from '@taktflow/core'
import { commandExecutor, type M3Callbacks } from './m3-routes.js'
import { body, HttpError, safeId, text } from './http.js'
import type { Handler } from './routes.js'

export type EvalRuntimeResolver = (stores: ProjectStores) => EngineDeps | Promise<EngineDeps>
export function registerEvalRoutes(register: (method: string, path: string, handler: Handler) => void, resolveRuntime: EvalRuntimeResolver, options: M3Callbacks = {}): void {
  const { execute } = commandExecutor({ ...options, resolveRuntime })
  const write = (id: string, fixed: (params: Record<string, string>) => Record<string, unknown> = () => ({})): Handler => async ({ stores, request, params }) => {
    const { reason, ...input } = await body(request, id === 'defect.attribute')
    return execute(stores, request, id, { ...input, ...fixed(params) }, reason === undefined ? `${id} via web` : text(reason, 'reason'))
  }
  const add: typeof register = (method, path, handler) => register(method, path, async (context) => {
    try { return await handler(context) } catch (error) {
      if (error instanceof HttpError) throw error
      const message = error instanceof Error ? error.message : String(error)
      if (/不存在/.test(message)) throw new HttpError(404, message)
      if (/必须|不能|非法|无效|不合法|缺少|没有|重复|只支持/.test(message) || error instanceof TypeError) throw new HttpError(400, message)
      throw error
    }
  })
  add('GET', '/api/eval/scorecards', ({ stores, url }) => scorecards(stores, { by: (url.searchParams.get('by') ?? 'node') as ScorecardOptions['by'], workflowId: url.searchParams.get('workflow') ?? undefined }))
  add('GET', '/api/eval/cases', ({ stores, url }) => listEvalCases(stores, url.searchParams.has('target') ? parseEvalTarget(url.searchParams.get('target')!) : undefined))
  add('POST', '/api/eval/cases/collect', write('eval.collect'))
  add('GET', '/api/eval/runs', ({ stores }) => listEvalRuns(stores))
  add('GET', '/api/eval/runs/:id', ({ stores, params }) => getEvalRun(stores, params.id!))
  add('GET', '/api/eval/runs/:id/output', ({ stores, params, url }) => getEvalOutput(stores, params.id!, text(url.searchParams.get('case'), 'case'), text(url.searchParams.get('variant'), 'variant')))
  add('POST', '/api/eval/runs', write('eval.run'))
  add('GET', '/api/requirements/:id/defects', ({ stores, params }) => listDefects(stores, safeId(params.id!)))
  add('POST', '/api/requirements/:id/defects', write('defect.report', (params) => ({ requirementId: safeId(params.id!) })))
  add('POST', '/api/requirements/:id/defects/:defectId/attribute', write('defect.attribute', (params) => ({ requirementId: safeId(params.id!), defectId: params.defectId })))
  add('POST', '/api/requirements/:id/defects/:defectId/confirm', write('defect.confirm', (params) => ({ requirementId: safeId(params.id!), defectId: params.defectId })))
}
