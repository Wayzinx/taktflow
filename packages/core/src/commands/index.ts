import type { CommandInfo, CommandRunResponse } from '../api.js'
import type { SpaceMember } from '../types.js'
import { validateSchema } from '../engine/schema.js'
import type { CommandContext, CommandDeps, CommandInputs, CommandRegistry, CommandSpec } from './contracts.js'
import { commandSchemas } from './schema.js'
export type * from './contracts.js'

import { requireRole } from './permissions.js'
export { requireRole } from './permissions.js'
export function createCommandRegistry(deps: CommandDeps): CommandRegistry {
  const { stores } = deps
  const invoke = <K extends keyof CommandInputs>(name: K): CommandSpec['handler'] => async (input, context) => {
    const handler = deps[name] as ((input: CommandInputs[K], context: CommandContext) => Promise<unknown>) | undefined
    if (!handler) throw new Error(`命令处理器未接入：${name}`)
    return handler(input as unknown as CommandInputs[K], context)
  }
  const define = (id: keyof typeof commandSchemas, title: string, risk: CommandInfo['risk'], handler: CommandSpec['handler'], minRole: SpaceMember['role'] = risk === 'read' ? 'viewer' : 'member'): CommandSpec =>
    ({ id, title, risk, kind: risk === 'read' ? 'query' : 'command', minRole, input: commandSchemas[id], handler })
  const specs = [
    define('requirement.status', '需求状态', 'read', async (input) => stores.workspaces.getRequirement(input.requirementId as string)),
    define('run.status', '运行状态', 'read', async (input) => stores.runs.get(input.runId as string)),
    define('attention.list', '待办列表', 'read', async (input) => stores.attention.list(input)),
    define('lessons.list', '经验列表', 'read', async (input) => stores.lessons?.list(input) ?? []),
    define('requirement.create', '创建需求', 'write', async (input) => stores.workspaces.createRequirement(input as { title: string })),
    define('route.preview', '路由预览', 'read', invoke('route')),
    define('run.start', '启动运行', 'write', invoke('startRun')),
    define('run.resume', '继续运行', 'write', invoke('resumeRun')),
    define('run.cancel', '取消运行', 'dangerous', invoke('cancelRun'), 'maintainer'),
    define('attention.answer', '回答待办', 'write', invoke('answerAttention')),
    define('task.dispatch', '派发任务', 'write', invoke('dispatchTask')),
    define('review.dispose', '处置评审问题', 'write', invoke('disposeReview')),
    define('lesson.status', '修改经验状态', 'write', invoke('setLessonStatus'), 'maintainer'),
    ...(deps.extensions ?? []),
  ]
  const commands = new Map(specs.map((spec) => [spec.id, spec]))
  if (commands.size !== specs.length) throw new Error('命令 id 重复')
  return {
    list: () => specs.map(({ handler: _handler, ...info }) => structuredClone(info)),
    async run(id, input, context) {
      let response: CommandRunResponse
      try {
        const spec = commands.get(id)
        if (!spec) throw new Error(`命令不存在：${id}`)
        validateSchema(input, spec.input)
        requireRole(stores, context.actor, spec.minRole ?? 'member', id)
        if (spec.risk !== 'read' && !context.reason?.trim()) throw new Error('写操作必须说明原因')
        if (['attention.answer', 'review.dispose'].includes(id) && context.actor.type !== 'human') throw new Error('必须由人显式处理')
        await deps.audit({ id, input, ...context, phase: 'requested' })
        const result = await spec.handler(input, context)
        response = { ok: true, message: `${spec.title}已执行`, result }
      } catch (error) {
        response = { ok: false, message: error instanceof Error ? error.message : String(error) }
      }
      await deps.audit({ id, input, ...context, phase: 'finished', response })
      return response
    },
  }
}
