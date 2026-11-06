import type { CommandRegistry } from '../commands/contracts.js'
import type { RouteInput } from '../route/index.js'
import type { LeadPresence, RouteDecision, WorkflowSnapshot } from '../types.js'
import type { Engine, ProjectStores } from '../interfaces.js'
import type { Actor, AgentProfile, HarnessAdapter, LeadActionResult, RunState, WorkflowDefinition } from '../types.js'
import type { RunSummary, WorkflowDocument, WorkflowSourceRequest } from '../api.js'

export interface LeadWorkflowAccess {
  list?(): Promise<Array<{ id: string; snapshot: WorkflowSnapshot }>>
  load(id: string): Promise<WorkflowDefinition>
  get(id: string): Promise<Pick<WorkflowDocument, 'rev' | 'source'>>
  replaceSource(id: string, request: WorkflowSourceRequest & { author: Actor; onBehalfOf: Actor }): Promise<unknown>
}

export interface LeadRuntimeOptions {
  withWriteLease?: <T>(stores: ProjectStores, fn: () => Promise<T>) => Promise<T>
  stores: ProjectStores
  harnesses: Record<string, HarnessAdapter>
  profiles: Record<string, AgentProfile>
  engineFactory(deps: { stores: ProjectStores; profiles: Record<string, AgentProfile>; harnesses: Record<string, HarnessAdapter> }): Engine
  workflows?: LeadWorkflowAccess
  instructions?: string
  commands?: CommandRegistry
  route?: (input: RouteInput) => Promise<RouteDecision>
  routeModel?: RouteInput['model']
  onPresence?: (requirementId: string, presence: LeadPresence) => void | Promise<void>
}

export type TaskRunState = RunState & Pick<RunSummary, 'kind' | 'origin'>
export interface LeadTurnResult { run: TaskRunState; results: LeadActionResult[] }
export const errorText = (error: unknown): string => error instanceof Error ? error.message : String(error)
