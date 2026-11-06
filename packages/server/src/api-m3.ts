import {
  getDefect, getEvalRun, getEvalOutput, listDefects, listEvalCases, listEvalRuns, parseEvalTarget, scorecards,
  type Actor, type CommandRegistry, type EngineDeps, type LeadPresence, type ProjectStores, type ScorecardOptions,
} from '@taktflow/core'
import type { WriteLease } from './api-core.js'
import { projectCommands } from './commands.js'
import { ApiError } from './errors.js'
import { requirement, nodeDetail } from './read-model.js'
import { safeId, text } from './validation.js'

export type EvalRuntimeResolver = (stores: ProjectStores) => EngineDeps | Promise<EngineDeps>
export interface M3Callbacks {
  resolveRuntime?: EvalRuntimeResolver
  getCommands?(stores: ProjectStores): CommandRegistry | Promise<CommandRegistry>
  getLeadPresence?(projectDir: string, requirementId: string): LeadPresence
  subscribeLead?(projectDir: string, requirementId: string, send: (presence: LeadPresence) => void): () => void
}
export type M3ReadOp = 'me' | 'commands' | 'lessons' | 'eval.scorecards' | 'eval.cases' | 'eval.runs' | 'eval.run' | 'eval.output' | 'defects' | 'defect' | 'recipe'
export type M3WriteOp = 'command.run' | 'route.preview' | 'lesson.update' | 'review.dispose' | 'eval.collect' | 'eval.run' | 'defect.report' | 'defect.attribute' | 'defect.confirm'
type Params = Record<string, string | undefined>

export function apiCommands(options: M3Callbacks, withWriteLease: WriteLease) {
  const commands = async (stores: ProjectStores, id?: string) => options.getCommands?.(stores) ?? projectCommands(stores, {},
    id && ['eval.run', 'defect.attribute'].includes(id) ? await options.resolveRuntime?.(stores) : undefined, withWriteLease)
  const execute = async (stores: ProjectStores, actor: Actor, id: string, input: Record<string, unknown>, reason?: string) => {
    const result = await (await commands(stores, id)).run(id, Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined)), { actor, reason }, (_, task) => task())
    if (!result.ok) throw new ApiError(/权限不足|必须由人/.test(result.message) ? 403 : /待办已/.test(result.message) ? 409 : /不存在/.test(result.message) ? 404 : 400, result.message)
    return result.result
  }
  return { commands, execute }
}

export async function evalOperation<T>(task: () => Promise<T>): Promise<T> {
  try { return await task() } catch (error) {
    if (error instanceof ApiError) throw error
    const message = error instanceof Error ? error.message : String(error)
    if (/不存在/.test(message)) throw new ApiError(404, message)
    if (/必须|不能|非法|无效|不合法|缺少|没有|重复|只支持/.test(message) || error instanceof TypeError) throw new ApiError(400, message)
    throw error
  }
}

export async function readM3(stores: ProjectStores, op: M3ReadOp, params: Params, actor: Actor, registry: ReturnType<typeof apiCommands>): Promise<unknown> {
  switch (op) {
    case 'me': {
      const id = actor.type === 'human' ? actor.id : actor.type === 'agent' ? actor.onBehalfOf ?? actor.role : actor.id
      const member = stores.config.members?.length ? stores.config.members.find((member) => member.id === id) : { id, name: id, role: 'owner' as const }
      return { id, name: member?.name ?? id, member }
    }
    case 'commands': return (await registry.commands(stores)).list()
    case 'lessons': return registry.execute(stores, actor, 'lessons.list', params.status === undefined ? {} : { status: params.status })
    case 'recipe': return (await nodeDetail(stores, params.runId!, params.nodeId!)).recipe
    case 'eval.scorecards': return evalOperation(() => scorecards(stores, { by: (params.by ?? 'node') as ScorecardOptions['by'], workflowId: params.workflow }))
    case 'eval.cases': return evalOperation(() => listEvalCases(stores, params.target === undefined ? undefined : parseEvalTarget(params.target)))
    case 'eval.runs': return evalOperation(() => listEvalRuns(stores))
    case 'eval.run': return evalOperation(() => getEvalRun(stores, params.id!))
    case 'eval.output': return evalOperation(() => getEvalOutput(stores, params.id!, text(params.case, 'case'), text(params.variant, 'variant')))
    case 'defects': return evalOperation(() => listDefects(stores, safeId(params.id!)))
    case 'defect': return evalOperation(() => getDefect(stores, safeId(params.id!), text(params.defectId, 'defectId')))
  }
}

export async function writeM3(stores: ProjectStores, op: M3WriteOp, params: Params, input: Record<string, unknown>, actor: Actor, registry: ReturnType<typeof apiCommands>): Promise<unknown> {
  if (op === 'command.run') {
    if (!input.input || typeof input.input !== 'object' || Array.isArray(input.input)) throw new ApiError(400, 'input 必须是对象')
    return (await registry.commands(stores, params.id)).run(params.id!, input.input as Record<string, unknown>, { actor, reason: input.reason === undefined ? undefined : text(input.reason, 'reason') }, (_, task) => task())
  }
  if (op === 'route.preview') {
    await requirement(stores, params.id!)
    const reason = input.reason === undefined ? undefined : text(input.reason, 'reason')
    if (input.tier !== undefined && !reason) throw new ApiError(400, '改档必须填写 reason')
    return registry.execute(stores, actor, op, { requirementId: params.id, ...(input.hint === undefined ? {} : { hint: input.hint }),
      ...(input.tier === undefined ? {} : { override: { tier: input.tier, reason } }) }, reason)
  }
  if (op === 'lesson.update') return registry.execute(stores, actor, op, { ...input, id: params.id }, text(input.reason, 'reason'))
  if (op === 'review.dispose') return registry.execute(stores, actor, op, { ...input, runId: params.runId, nodeId: params.nodeId }, text(input.reason, 'reason'))
  const { reason, ...values } = input
  const fixed = op.startsWith('defect.') ? { requirementId: safeId(params.id!), ...(params.defectId === undefined ? {} : { defectId: params.defectId }) } : {}
  return evalOperation(() => registry.execute(stores, actor, op, { ...values, ...fixed }, reason === undefined ? `${op} via web` : text(reason, 'reason')))
}
