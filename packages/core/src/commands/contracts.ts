import type { CommandInfo, CommandRunResponse } from '../api.js'
import type { ProjectStores } from '../interfaces.js'
import type { Actor, RouteDecision, RunBudget, TaskSpec, Tier } from '../types.js'

export interface CommandContext { actor: Actor; reason?: string }
export interface CommandInputs {
  startRun: { requirementId: string; workflowId: string; args?: Record<string, unknown>; budget?: RunBudget; route?: RouteDecision }
  resumeRun: { runId: string }
  cancelRun: { runId: string }
  answerAttention: { requestId: string; decision: 'approve' | 'reject' | 'answer' | 'choice'; answer?: string }
  dispatchTask: { requirementId: string; task: TaskSpec }
  disposeReview: { runId: string; nodeId: string; groupKey: string; state: 'open' | 'resolved' | 'dismissed' }
  setLessonStatus: { id: string; status: 'tentative' | 'active' | 'retired' }
  route: { requirementId: string; hint?: string; override?: { tier: Tier; reason: string } }
}
export type CommandHandlers = { [K in keyof CommandInputs]?: (input: CommandInputs[K], context: CommandContext) => Promise<unknown> }
export interface CommandAudit extends CommandContext { id: string; input: Record<string, unknown>; phase: 'requested' | 'finished'; response?: CommandRunResponse }
export interface CommandSpec extends CommandInfo { handler(input: Record<string, unknown>, context: CommandContext): Promise<unknown> }
export interface CommandDeps extends CommandHandlers {
  stores: ProjectStores
  audit(entry: CommandAudit): Promise<unknown>
  extensions?: CommandSpec[]
}
export interface CommandRegistry {
  list(): CommandInfo[]
  run(id: string, input: Record<string, unknown>, context: CommandContext): Promise<CommandRunResponse>
}
