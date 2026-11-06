/**
 * 命令注册表演示（docs/design/19 §9）：⌘K、Lead、CLI 共用一套命令；界面和 Agent 调同一个 id。
 * 执行由 mock.ts 分派到对应的演示接口；业务失败返回 ok: false，不抛错。
 */
import type { CommandInfo, CommandRunRequest, CommandRunResponse } from '@taktflow/core'

const str = (title: string, extra: Record<string, unknown> = {}) => ({ type: 'string', title, ...extra })

export const MOCK_COMMANDS: CommandInfo[] = [
  { id: 'requirement.status', title: '查看需求状态', kind: 'query', risk: 'read', input: { type: 'object', properties: { requirementId: str('需求') }, required: ['requirementId'] }, keywords: ['进度', 'status'], scope: ['requirement'] },
  { id: 'attention.list', title: '我的待办', kind: 'query', risk: 'read', input: { type: 'object', properties: { mine: { type: 'boolean', title: '只看派给我的' } } }, keywords: ['待办', 'todo', 'inbox'] },
  { id: 'route.preview', title: '预览路由 / 改档', kind: 'query', risk: 'read', input: { type: 'object', properties: { requirementId: str('需求'), tier: str('档位', { enum: ['T0', 'T1', 'T2', 'T3'] }), reason: str('改档原因') }, required: ['requirementId'] }, keywords: ['档位', 'tier', 'route', 'quick-fix'], scope: ['requirement'] },
  { id: 'run.start', title: '启动流水线', kind: 'command', risk: 'write', minRole: 'member', input: { type: 'object', properties: { requirementId: str('需求'), workflowId: str('流程', { default: 'auto' }) }, required: ['requirementId'] }, keywords: ['运行', 'start', 'run'], scope: ['requirement'] },
  { id: 'run.cancel', title: '终止运行', kind: 'command', risk: 'dangerous', minRole: 'maintainer', input: { type: 'object', properties: { runId: str('运行') }, required: ['runId'] }, keywords: ['取消', 'cancel', 'stop'], scope: ['run'] },
  { id: 'node.retry', title: '重跑节点', kind: 'command', risk: 'write', minRole: 'member', input: { type: 'object', properties: { runId: str('运行'), nodeId: str('节点') }, required: ['runId', 'nodeId'] }, keywords: ['retry', '再试一次'], scope: ['run', 'node'] },
  { id: 'budget.extend', title: '追加 50% 预算', kind: 'command', risk: 'write', minRole: 'maintainer', input: { type: 'object', properties: { runId: str('运行') }, required: ['runId'] }, keywords: ['预算', 'budget'], scope: ['run'] },
  { id: 'review.dispose', title: '处置评审问题', kind: 'command', risk: 'write', minRole: 'member', input: { type: 'object', properties: { runId: str('运行'), nodeId: str('节点'), groupKey: str('问题'), state: str('处置', { enum: ['resolved', 'dismissed', 'open'] }) }, required: ['runId', 'nodeId', 'groupKey', 'state'] }, keywords: ['驳回', '已解决', 'dismiss'], scope: ['run', 'node'] },
  { id: 'lesson.update', title: '启用 / 退役经验', kind: 'command', risk: 'write', minRole: 'maintainer', input: { type: 'object', properties: { id: str('经验'), status: str('状态', { enum: ['tentative', 'active', 'retired'] }) }, required: ['id', 'status'] }, keywords: ['经验', 'lesson'] },
  { id: 'repo.sync', title: '同步代码仓库', kind: 'command', risk: 'write', minRole: 'member', input: { type: 'object', properties: { repoId: str('仓库') }, required: ['repoId'] }, keywords: ['git', 'pull', 'sync'] },
  { id: 'workflow.rollback', title: '回滚 workflow', kind: 'command', risk: 'dangerous', minRole: 'maintainer', input: { type: 'object', properties: { workflowId: str('workflow'), rev: str('修订') }, required: ['workflowId', 'rev'] }, keywords: ['回滚', 'revert'] },
]

export type CommandHandler = (input: Record<string, unknown>, reason?: string) => Promise<CommandRunResponse>

/** 校验风险与必填参数，再交给 handler；没有 handler 的命令返回演示提示。 */
export async function runMockCommand(id: string, body: CommandRunRequest, handlers: Record<string, CommandHandler>): Promise<CommandRunResponse> {
  const cmd = MOCK_COMMANDS.find((c) => c.id === id)
  if (!cmd) return { ok: false, message: `命令 ${id} 不存在` }
  if (cmd.risk !== 'read' && !body.reason?.trim()) return { ok: false, message: `「${cmd.title}」会改变状态，需要写原因` }
  const required = ((cmd.input as { required?: string[] }).required ?? []).filter((k) => body.input[k] === undefined || body.input[k] === '')
  if (required.length) return { ok: false, message: `缺少参数：${required.join('、')}` }
  const h = handlers[id]
  if (!h) return { ok: true, message: `已执行「${cmd.title}」（演示数据不改变状态）` }
  try {
    return await h(body.input, body.reason)
  } catch (e) {
    return { ok: false, message: (e as Error).message }
  }
}
