import type { NodeContext } from '../../types.js'
import type { Entry } from '../graph.js'
import type { NodeHost } from './host.js'
import type { GateCheckResult } from '../../types.js'
import { BlockedError } from '../harness.js'
import { inlineAsset } from '../capture-assets.js'
import { canonicalJson } from '../../util/hash.js'
import { scheduleCheckpoint, materializeCheckpoint } from '../checkpoint.js'
import { RUBRIC_TEMPLATE } from '../prompt-renderer.js'
import { RUBRIC_SCHEMA } from './schemas.js'
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error)

export async function run(host: NodeHost, entry: Entry, ctx: NodeContext): Promise<void> {
  const node = entry.def
  if (node.kind !== 'gate') throw new Error('内部错误：不是 gate')
  const ns = host.state.nodes[node.id]!

  const scheduled = new Map<string, Awaited<ReturnType<typeof scheduleCheckpoint>>>()
  for (const check of node.checks) if (check.kind === 'rubric') {
    const duty = inlineAsset(`rubric:${node.id}:${check.id}`, canonicalJson({ template: RUBRIC_TEMPLATE, rubric: check.rubric }))
    scheduled.set(check.id, await scheduleCheckpoint(host, node.id, (ns.inputs ?? []).map((ref) => ({ ref, role: 'target' })), duty, { checkId: check.id }))
  }
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
      } else {
        const checkpoint = scheduled.get(check.id)!
        const snapshotDir = await materializeCheckpoint(host, checkpoint)
        const value = await host.model(entry, { ...ctx, workspaceDir: snapshotDir }, check.role, `按以下 rubric 检查并输出 score、pass、message：\n${check.rubric}`, RUBRIC_SCHEMA, { gateCheckId: check.id, checkpoint, snapshotDir, materials: checkpoint.materials,
          render: { kind: 'rubric', template: RUBRIC_TEMPLATE, params: { rubric: check.rubric }, duty: inlineAsset(`rubric:${node.id}:${check.id}`, canonicalJson({ template: RUBRIC_TEMPLATE, rubric: check.rubric })) } }) as GateCheckResult
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
