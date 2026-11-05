import type { NodeContext } from '../../types.js'
import type { Entry } from '../graph.js'
import type { NodeHost } from './host.js'
import type { GateCheckResult } from '../../types.js'
import { BlockedError } from '../harness.js'
import { RUBRIC_SCHEMA } from './schemas.js'
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error)

export async function run(host: NodeHost, entry: Entry, ctx: NodeContext): Promise<void> {
  const node = entry.def
  if (node.kind !== 'gate') throw new Error('内部错误：不是 gate')
  const ns = host.state.nodes[node.id]!

  const checks: GateCheckResult[] = []
  for (const check of node.checks) {
    try {
      if (check.kind === 'command') {
        const result = await host.shell(check.run, ctx, node.timeoutMs)
        checks.push({ id: check.id, pass: result.code === 0, message: result.output })
      } else if (check.kind === 'function') {
        host.signal.throwIfAborted()
        const result = await host.guard.system(host.workspacePaths(node.outputs?.map((output) => output.path)), () => check.fn(ctx), true)
        checks.push({ ...result, id: check.id, pass: result.pass === true })
      } else if (check.kind === 'acceptance') {
        // 交付校验由 m3-engine 实现；实现前按 fail-closed 处理
        checks.push({ id: check.id, pass: false, message: '交付校验尚未实现' })
      } else {
        const value = await host.model(entry, ctx, check.role, `按以下 rubric 检查并输出 score、pass、message：\n${check.rubric}`, RUBRIC_SCHEMA) as GateCheckResult
        checks.push({ ...value, id: check.id, pass: value.pass && value.score! >= check.threshold })
      }
    } catch (error) {
      if (error instanceof BlockedError) throw error
      checks.push({ id: check.id, pass: false, message: errorText(error) })
    }
  }
  host.signal.throwIfAborted()
  const pass = checks.every((check) => check.pass)
  ns.result = { pass, checks }
  await host.emit('gate.result', { pass, checks }, node.id)
  if (!pass) {
    if (node.onFail === 'human') await host.request(entry, `门禁未通过，请裁决：${JSON.stringify(checks.filter((c) => !c.pass))}`, 'approve', undefined, true)
    else throw new Error(`门禁未通过：${checks.filter((check) => !check.pass).map((check) => `${check.id}: ${check.message ?? '失败'}`).join('; ')}`)
  }

}
