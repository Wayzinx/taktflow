import type { CommandRegistry, LeadPresence, ProjectStores, RoomMessage } from '@taktflow/core'
import type { EvalRuntimeResolver } from './eval-routes.js'
import { actor, authorize, body, HttpError, text, viewer } from './http.js'
import { projectCommands } from './space.js'
import type { Handler } from './routes.js'
import { requirement } from './read-model.js'
import { routeRequirement, RouteUnavailableError } from '@taktflow/core'
import { configuredRouteModel } from './knowledge-runtime.js'
import { routingWorkflows } from './commands.js'

export interface M3Callbacks {
  resolveRuntime?: EvalRuntimeResolver
  /** 运行时命令负责回答后的续跑；HTTP 路由不再重复调用 onAnswer。 */
  getCommands?(stores: ProjectStores): CommandRegistry | Promise<CommandRegistry>
  getLeadPresence?(projectDir: string, requirementId: string): LeadPresence
  resendTask?(projectDir: string, requirementId: string, message: RoomMessage, reason: string): Promise<RoomMessage | undefined>
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
    if (!result.ok) throw new HttpError(/权限不足|必须由人/.test(result.message) ? 403 : /待办已|先取消运行|已有运行|已变化|已改变|冲突|已存在|还没有可用的流水线|没有支持 T\d 的流水线/.test(result.message) ? 409 : /不存在/.test(result.message) ? 404 : 400, result.message)
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
    const result = await (await commands(stores, params.id)).run(params.id!, input.input as Record<string, unknown>, { actor: actor(request, stores), reason: input.reason === undefined ? undefined : text(input.reason, 'reason', allowEmptyReason) })
    if (['run.resume', 'run.retry'].includes(params.id!) && !result.ok) throw new HttpError(400, result.message)
    return result
  })
  add('POST', '/api/requirements/:id/route', async ({ stores, request, params }) => {
    await requirement(stores, params.id!)
    const input = await body(request)
    const reason = input.reason === undefined ? undefined : text(input.reason, 'reason')
    if (input.tier !== undefined && !reason) throw new HttpError(400, '改档必须填写 reason')
    return execute(stores, request, 'route.preview', { requirementId: params.id, ...(input.hint === undefined ? {} : { hint: input.hint }),
      ...(input.tier === undefined ? {} : { override: { tier: input.tier, reason } }) }, reason)
  })
  add('POST', '/api/route/preview', async ({ stores, request }) => {
    authorize(request, stores, 'viewer')
    const input = await body(request)
    const draftText = typeof input.text === 'string' ? input.text.trim() : ''
    if (!draftText) throw new HttpError(400, 'text 必须是非空字符串')
    if (input.repos !== undefined && (!Array.isArray(input.repos) || input.repos.some((repo) => typeof repo !== 'string' || !repo.trim())))
      throw new HttpError(400, 'repos 必须是字符串数组')
    const [title, ...rest] = draftText.split(/\r?\n/)
    // 空间没有流水线、或没有接得住该档位的流水线是配置问题：409 带原因，前端据此提示去建流水线。
    return routeRequirement({
      stores,
      draft: { title: title!.trim(), description: rest.join('\n').trim() || undefined },
      workflows: await routingWorkflows(stores),
      model: configuredRouteModel(stores),
      by: actor(request, stores),
      ...(input.hint === undefined ? {} : { hint: text(input.hint, 'hint') }),
      ...(input.repos === undefined ? {} : { repos: input.repos }),
    }).catch((error: unknown) => { throw error instanceof RouteUnavailableError ? new HttpError(409, error.message) : error })
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
