import type { AgentRoleView, AgentRoleWrite, AutomationConfig, AutomationDelivery, AutomationRunRecord, AutomationsView, AutomationView, ChannelConfig, ChannelView } from '@taktflow/core'

/** 角色档案 PUT 时 baseRevision 不一致（409）：别人刚改过，需要重新载入。 */
export class RoleConflictError extends Error {
  constructor(message = '角色档案已被其他人修改，请刷新后重试') {
    super(message)
  }
}

/** M8 接口：角色结构化读写、自动化与通知渠道（docs/design/30 §3、§4）。路由见 packages/core/src/api.ts 顶部的接口表。 */
export interface M8Source {
  agentRoles(): Promise<AgentRoleView[]>
  agentRole(role: string): Promise<AgentRoleView>
  /** 不存在时新建；409 时抛 RoleConflictError。 */
  saveAgentRole(role: string, write: AgentRoleWrite): Promise<AgentRoleView>
  /** 还有 workflow 节点用它时 409，消息里列出节点。 */
  deleteAgentRole(role: string, reason: string): Promise<void>
  automations(): Promise<AutomationsView>
  saveAutomation(automation: AutomationConfig, reason: string): Promise<AutomationView>
  deleteAutomation(id: string, reason: string): Promise<void>
  triggerAutomation(id: string, reason: string): Promise<AutomationRunRecord>
  /** 最近 20 次，新的在前。 */
  automationRuns(id: string): Promise<AutomationRunRecord[]>
  retryAutomationRun(id: string, recordId: string, reason: string): Promise<AutomationRunRecord>
  saveChannel(channel: ChannelConfig, reason: string): Promise<ChannelView>
  /** 还有自动化引用时 409。 */
  deleteChannel(id: string, reason: string): Promise<void>
  testChannel(id: string, reason: string): Promise<AutomationDelivery>
}
