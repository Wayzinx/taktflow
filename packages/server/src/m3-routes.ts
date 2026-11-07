import type { CommandRegistry, LeadPresence, ProjectStores } from '@taktflow/core'
import type { EvalRuntimeResolver } from './eval-routes.js'
import { actor, body, HttpError, text, viewer } from './http.js'
import { projectCommands } from './space.js'
import type { Handler } from './routes.js'
import { requirement } from './read-model.js'

export interface M3Callbacks {
  resolveRuntime?: EvalRuntimeResolver
  getCommands?(stores: ProjectStores): CommandRegistry | Promise<CommandRegistry>
  getLeadPresence?(projectDir: string, requirementId: string): LeadPresence
  subscribeLead?(projectDir: string, requirementId: string, send: (presence: LeadPresence) => void): () => void
}
export function commandExecutor(options: M3Callbacks = {}) {
  const commands = async (stores: ProjectStores, id?: string): Promise<CommandRegistry> => {
    if (id?.startsWith('requirement.')) return projectCommands(stores, options.getCommands ? {
      startRun: async (input, context) => {
        const runtime = await options.getCommands!(stores)
        const clean = Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined))
        const response = await runtime.run('run.start', clean, context)
        if (!response.ok) throw new Error(response.message)
        return response.result
      },
    } : {})
    return options.getCommands?.(stores) ?? projectCommands(stores, {},
      id && ['eval.run', 'defect.attribute'].includes(id) ? await options.resolveRuntime?.(stores) : undefined)
  }
  const execute = async (stores: ProjectStores, request: Parameters<typeof actor>[0], id: string, input: Record<string, unknown>, reason?: string) => {
    const result = await (await commands(stores, id)).run(id, Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined)), { actor: actor(request, stores), reason })
    if (!result.ok) throw new HttpError(/权限不足|必须由人/.test(result.message) ? 403 : /待办已|先取消运行|已有运行|已变化|冲突|已存在/.test(result.message) ? 409 : /不存在/.test(result.message) ? 404 : 400, result.message)
    return result.result
  }
  return { commands, execute }
}
export function m3Routes(add: (method: string, path: string, handler: Handler) => void, options: M3Callbacks) {
  const { commands, execute } = commandExecutor(options)
  add('GET', '/api/me', ({ stores, request }) => viewer(request, stores))
  add('GET', '/api/commands', async ({ stores }) => (await commands(stores)).list())
  add('POST', '/api/commands/:id', async ({ stores, request, params }) => {
    const input = await body(request, false, params.id === 'requirement.create' ? 30 * 1024 * 1024 : 8 * 1024 * 1024)
    if (!input.input || typeof input.input !== 'object' || Array.isArray(input.input)) throw new HttpError(400, 'input 必须是对象')
    const allowEmptyReason = params.id === 'requirement.create'
    return (await commands(stores, params.id)).run(params.id!, input.input as Record<string, unknown>, { actor: actor(request, stores), reason: input.reason === undefined ? undefined : text(input.reason, 'reason', allowEmptyReason) })
  })
  add('POST', '/api/requirements/:id/route', async ({ stores, request, params }) => {
    await requirement(stores, params.id!)
    const input = await body(request)
    const reason = input.reason === undefined ? undefined : text(input.reason, 'reason')
    if (input.tier !== undefined && !reason) throw new HttpError(400, '改档必须填写 reason')
    return execute(stores, request, 'route.preview', { requirementId: params.id, ...(input.hint === undefined ? {} : { hint: input.hint }),
      ...(input.tier === undefined ? {} : { override: { tier: input.tier, reason } }) }, reason)
  })
  add('GET', '/api/lessons', async ({ stores, request, url }) => execute(stores, request, 'lessons.list', url.searchParams.has('status') ? { status: url.searchParams.get('status') } : {}))
  add('PATCH', '/api/lessons/:id', async ({ stores, request, params }) => {
    const input = await body(request)
    // 其他字段需要同样的 schema / 权限 / 审计，所以也通过注册表扩展命令处理。
    return execute(stores, request, 'lesson.update', { ...input, id: params.id }, text(input.reason, 'reason'))
  })
  add('POST', '/api/runs/:runId/nodes/:nodeId/dispositions', async ({ stores, request, params }) => {
    const input = await body(request)
    return execute(stores, request, 'review.dispose', { ...input, runId: params.runId, nodeId: params.nodeId }, text(input.reason, 'reason'))
  })
}
