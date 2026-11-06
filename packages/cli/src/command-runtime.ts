import { startRouted, type CommandContext, type CommandRegistry, type LeadAction, type RoomMessage } from '@taktflow/core'
import { answerAttention, routingWorkflows } from '@taktflow/server'
import { projectCommands } from './project-commands.js'
import { engineDependencies, type ProjectContext } from './project.js'
import { cliWriteLease, type WriteLeaseHook } from './lease.js'
import type { ProjectLead } from './lead.js'

export function runtimeCommands(context: ProjectContext, lead: () => Pick<ProjectLead, 'executeAction' | 'onAttention'>, withWriteLease: WriteLeaseHook = cliWriteLease): CommandRegistry {
  const stores = context.stores
  const execute = async (action: LeadAction, input: { requirementId?: string; runId?: string; route?: import('@taktflow/core').RouteDecision }, by: CommandContext) => {
    const requirementId = input.requirementId ?? (input.runId ? (await stores.runs.get(input.runId))?.requirementId : undefined)
    if (!requirementId || !await stores.workspaces.getRequirement(requirementId)) throw new Error('需求或运行不存在')
    const messages = await stores.chat.list(requirementId)
    // Lead 的命令原因带原始消息 ID；外部命令追加一条来源记录，保持任务来源可追溯。
    const trigger = messages.find((message) => by.reason?.startsWith(`Lead 响应消息 ${message.id}：`))
      ?? await stores.chat.post(requirementId, { author: by.actor, kind: 'system', text: by.reason! })
    const parent = (await stores.runs.list({ requirementId })).find((run) => run.workflowId === 'lead' && run.origin?.messageId === trigger.id)
    const result = await lead().executeAction(action, requirementId, trigger as RoomMessage, parent?.runId, 0, input.route)
    if (!result.ok) throw new Error(result.message)
    return result
  }
  return projectCommands(stores, {
    startRun: async (input, by) => {
      const routed = await startRouted(stores, input.workflowId === 'auto' ? await routingWorkflows(stores) : [], input, by.actor)
      return execute({ type: 'start_run', workflowId: routed.workflowId, args: routed.args, ...(input.budget ? { budget: input.budget } : {}) }, routed, by)
    },
    resumeRun: (input, by) => execute({ type: 'resume_run', runId: input.runId }, input, by),
    cancelRun: (input, by) => execute({ type: 'cancel_run', runId: input.runId, reason: by.reason! }, input, by),
    dispatchTask: (input, by) => execute({ type: 'dispatch_task', task: input.task }, input, by),
    answerAttention: async (input, by) => {
      const item = await answerAttention(stores, input, by.actor)
      if (!await lead().onAttention(item)) await execute({ type: 'resume_run', runId: item.runId }, { runId: item.runId }, by)
      return item
    },
  }, engineDependencies(context), withWriteLease)
}
