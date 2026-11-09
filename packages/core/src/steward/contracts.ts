import type { Actor, ChatRequest, ChatResponse, RoomMessage } from '../types.js'
import type { ProjectStores } from '../interfaces.js'
import type { CommandRegistry } from '../commands/contracts.js'
import type { Risk, SpaceSummary, WorkflowDocument, WorkflowEdit, WorkflowSummary } from '../api.js'

export interface StewardSpace {
  id: string
  name: string
  dir: string
  stores: ProjectStores
  commands: CommandRegistry
  workflows: {
    list?(options?: { record?: boolean }): Promise<WorkflowSummary[]>
    get(id: string): Promise<WorkflowDocument>
    rollback(id: string, rev: string, by: Actor, reason: string): Promise<unknown>
  }
  postToLead(requirementId: string, text: string): Promise<string>
  onChat(requirementId: string, listener: (message: RoomMessage) => void): () => void
}
export interface StewardDeps {
  dataDir(userId: string): string
  spaces(): Promise<SpaceSummary[]>
  open(spaceId: string): Promise<StewardSpace>
  serverCommands?: CommandRegistry
  chat?: (request: ChatRequest, onToken?: (text: string) => void) => Promise<ChatResponse>
  now?: () => Date
  extraRisks?: (space: StewardSpace) => Promise<Array<Omit<Risk, 'state'> | Risk>>
  applyWorkflowEdits?: (
    source: string,
    edits: WorkflowEdit[],
  ) => { source: string; diagnostics?: Array<{ severity: string; message: string }> }
  systemPrompt?: string
  leadTimeoutMs?: number
}
export class StewardError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}
export const stewardActor: Actor = { type: 'agent', role: 'steward', harness: 'steward' }
export const timestamp = (deps: StewardDeps) => (deps.now?.() ?? new Date()).toISOString()
export function stewardUserId(id: string): string {
  if (
    typeof id !== 'string' ||
    !id.trim() ||
    id === '.' ||
    id === '..' ||
    /[\u0000-\u001f/\\]/.test(id) ||
    id.length > 160
  ) {
    throw new StewardError(400, '用户标识不合法，请使用不含路径分隔符的用户名称')
  }
  return id
}
export function stewardId(id: string): string {
  if (
    typeof id !== 'string' ||
    !/^[\p{L}\p{N}_@.-]+$/u.test(id) ||
    id === '.' ||
    id === '..' ||
    id.length > 160
  ) {
    throw new StewardError(400, '标识不合法，请使用不含路径分隔符的名称')
  }
  return id
}
