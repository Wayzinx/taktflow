/**
 * 命令注册表演示（docs/design/19 §9）：⌘K、Lead、CLI 共用一套命令；界面和 Agent 调同一个 id。
 *
 * 与真实注册表逐条对齐（运行时不能 import core，只能手工同步）：
 * - packages/core/src/commands/schema.ts 的 commandSchemas 与 commands/index.ts 的标题 / 风险 / minRole；
 * - packages/server/src/commands.ts 的扩展命令 lesson.update；
 * - packages/core/src/commands/eval-commands.ts 的 eval.* / defect.*。
 * 真实注册表不带 keywords / scope；⌘K 从 input.required 推断能从页面带入的参数（items.ts contextFits）。
 * 改了真实 schema 记得同步这里，否则 mock 会掩盖参数形状的错误。
 * 执行由 mock.ts 分派到对应的演示接口；业务失败返回 ok: false，不抛错。
 */
import type { CommandInfo, CommandRunRequest, CommandRunResponse } from '@taktflow/core'

const text = { type: 'string' }
const strings = { type: 'array', items: text }
const tierEnum = { type: 'string', enum: ['T0', 'T1', 'T2', 'T3'] }
const lessonStatus = { type: 'string', enum: ['tentative', 'active', 'retired'] }
const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties, required })
const budget = { type: 'object', properties: { tokens: { type: 'number' }, costUsd: { type: 'number' }, minutes: { type: 'number' }, concurrency: { type: 'integer' } } }
const task = {
  type: 'object',
  required: ['role', 'title', 'instructions'],
  properties: { role: text, title: text, instructions: text, repo: text, inputs: strings, writeScope: strings, completion: strings, impact: { type: 'string', enum: ['cosmetic', 'semantic'] }, outputs: { type: 'array', items: obj({ path: text, kind: text }, ['path', 'kind']) } },
}
const evalTarget = obj({ kind: { type: 'string', enum: ['node', 'skill'] }, name: text, workflowId: text, nodeId: text }, ['kind'])
const selector = obj({ harness: text, model: text, effort: text }, ['harness'])

type Def = [id: string, title: string, risk: CommandInfo['risk'], input: Record<string, unknown>, minRole?: CommandInfo['minRole']]
const define = ([id, title, risk, input, minRole]: Def): CommandInfo => ({ id, title, risk, kind: risk === 'read' ? 'query' : 'command', minRole: minRole ?? (risk === 'read' ? 'viewer' : 'member'), input })

export const MOCK_COMMANDS: CommandInfo[] = (
  [
    // core/commands/index.ts
    ['requirement.status', '需求状态', 'read', obj({ requirementId: text }, ['requirementId'])],
    ['run.status', '运行状态', 'read', obj({ runId: text }, ['runId'])],
    ['attention.list', '待办列表', 'read', obj({ requirementId: text, pending: { type: 'boolean' } })],
    ['lessons.list', '经验列表', 'read', obj({ status: lessonStatus })],
    ['requirement.create', '创建需求', 'write', obj({ id: text, title: text, owner: text, links: { type: 'array', items: obj({ type: text, url: text, title: text }, ['type', 'url']) } }, ['title'])],
    ['route.preview', '路由预览', 'read', obj({ requirementId: text, hint: text, override: obj({ tier: tierEnum, reason: text }, ['tier', 'reason']) }, ['requirementId'])],
    ['run.start', '启动运行', 'write', obj({ requirementId: text, workflowId: text, args: { type: 'object' }, budget, route: { type: 'object' } }, ['requirementId', 'workflowId'])],
    ['run.resume', '继续运行', 'write', obj({ runId: text }, ['runId'])],
    ['run.cancel', '取消运行', 'dangerous', obj({ runId: text }, ['runId']), 'maintainer'],
    ['attention.answer', '回答待办', 'write', obj({ requestId: text, decision: { type: 'string', enum: ['approve', 'reject', 'answer', 'choice'] }, answer: text }, ['requestId'])],
    ['task.dispatch', '派发任务', 'write', obj({ requirementId: text, task }, ['requirementId', 'task'])],
    ['review.dispose', '处置评审问题', 'write', obj({ runId: text, nodeId: text, groupKey: text, state: { type: 'string', enum: ['open', 'resolved', 'dismissed'] } }, ['runId', 'nodeId', 'groupKey', 'state'])],
    ['lesson.status', '修改经验状态', 'write', obj({ id: text, status: lessonStatus }, ['id', 'status']), 'maintainer'],
    // server/commands.ts 扩展
    ['lesson.update', '编辑经验', 'write', obj({ id: text, title: text, body: text, status: lessonStatus, trigger: obj(Object.fromEntries(['roles', 'paths', 'signatures', 'categories'].map((k) => [k, strings]))) }, ['id']), 'maintainer'],
    // core/commands/eval-commands.ts
    ['eval.scorecards', '查询评测成绩单', 'read', obj({ by: { type: 'string', enum: ['node', 'recipe', 'skill'] }, workflowId: text })],
    ['defect.report', '录入逃逸缺陷', 'write', obj({ requirementId: text, title: text, description: text, severity: { type: 'string', enum: ['critical', 'major', 'minor'] }, acs: strings, evidence: strings, links: { type: 'array' } }, ['requirementId', 'title', 'description', 'severity'])],
    ['defect.attribute', '生成候选归因', 'write', obj({ requirementId: text, defectId: text }, ['requirementId', 'defectId'])],
    ['defect.confirm', '人工确认归因', 'write', obj({ requirementId: text, defectId: text, attribution: { type: 'object' }, note: text }, ['requirementId', 'defectId'])],
    ['eval.collect', '收集评测用例', 'write', obj({ target: evalTarget, runIds: strings, includeDefects: { type: 'boolean' } })],
    ['eval.run', '启动回放评测', 'write', obj({ target: evalTarget, caseIds: strings, judge: selector, variants: { type: 'array', items: obj({ id: text, label: text, skillsDir: text, promptFile: text, profileFile: text, harness: selector }, ['id', 'label']) } }, ['target', 'variants'])],
  ] satisfies Def[]
).map(define)

export type CommandHandler = (input: Record<string, unknown>, reason?: string) => Promise<CommandRunResponse>

/** 与真实注册表的校验顺序一致：命令存在 → 必填参数 → 写操作要原因；再交给 handler，没有 handler 的返回演示提示。 */
export async function runMockCommand(id: string, body: CommandRunRequest, handlers: Record<string, CommandHandler>): Promise<CommandRunResponse> {
  const cmd = MOCK_COMMANDS.find((c) => c.id === id)
  if (!cmd) return { ok: false, message: `命令不存在：${id}` }
  const required = ((cmd.input as { required?: string[] }).required ?? []).filter((k) => body.input[k] === undefined || body.input[k] === '')
  if (required.length) return { ok: false, message: `缺少参数：${required.join('、')}` }
  if (cmd.risk !== 'read' && !body.reason?.trim()) return { ok: false, message: '写操作必须说明原因' }
  const h = handlers[id]
  if (!h) return { ok: true, message: `${cmd.title}已执行（演示数据不改变状态）` }
  try {
    return await h(body.input, body.reason)
  } catch (e) {
    return { ok: false, message: (e as Error).message }
  }
}
