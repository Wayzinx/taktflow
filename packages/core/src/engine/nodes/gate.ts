import type { NodeContext } from '../../types.js'
import type { Entry } from '../graph.js'
import type { NodeHost } from './host.js'
import type { GateCheckResult } from '../../types.js'
import { scheduleCheckpoint, finishCheckpoint, withCapture, rubricDuties } from '../checkpoints.js'
import { createSnapshot, artifactMaterials, snapshotPrompt } from '../snapshots.js'
import { checkAcceptance } from '../acceptance.js'
import { FailureError } from '../fingerprint.js'
import { BlockedError } from '../harness.js'
import { RUBRIC_SCHEMA } from './schemas.js'
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error)

export async function run(host: NodeHost, entry: Entry, ctx: NodeContext): Promise<void> {
  const node = entry.def
  if (node.kind !== 'gate') throw new Error('内部错误：不是 gate')
  const ns = host.state.nodes[node.id]!

  const checks: GateCheckResult[] = []
  const scheduled = []
  for (const check of node.checks) scheduled.push(await scheduleCheckpoint(host, node.id, check.kind === 'function' ? 'command' : check.kind, check.id,
    check.kind === 'rubric' ? rubricDuties(check.rubric) : [check.title ?? check.id]))
  for (const [index, check] of node.checks.entries()) {
    const point = scheduled[index]!
    let result: GateCheckResult
    let blocked: BlockedError | undefined
    try {
      host.signal.throwIfAborted()
      if (check.kind === 'command') {
        const output = await host.shell(check.run, ctx, node.timeoutMs)
        result = { id: check.id, pass: output.code === 0, message: output.output }
      } else if (check.kind === 'function') {
        result = await host.guard.system(host.workspacePaths(node.outputs?.map(output => output.path)), () => check.fn(ctx), true)
      } else if (check.kind === 'acceptance') {
        result = await withCapture(host, node.id, { role: 'acceptance', checkpointId: point.id }, () => checkAcceptance(host, entry, check.id, check.role))
      } else {
        const snapshot = await createSnapshot(host, point, await artifactMaterials(host, ns.inputs ?? [], 'target'))
        const value = await withCapture(host, node.id, { role: 'rubric', checkpointId: point.id, snapshot }, () => host.model(entry, ctx, check.role,
          `按以下 rubric 检查并输出 score、pass、message：\n${check.rubric}\n${snapshotPrompt(host.deps.stores.taktDir, snapshot)}`, RUBRIC_SCHEMA)) as GateCheckResult
        result = { ...value, pass: value.pass === true && value.score! >= check.threshold }
      }
      result = { ...result, id: check.id, pass: result.status !== 'error' && result.pass === true, status: result.status === 'error' ? 'error' : result.pass === true ? 'pass' : 'fail', checkpointId: point.id }
    } catch (error) {
      result = { id: check.id, pass: false, status: 'error', checkpointId: point.id, message: errorText(error) }
      if (error instanceof BlockedError) blocked = error
    }
    checks.push(result)
    await finishCheckpoint(host, point, result.status === 'error' ? 'error' : 'done', result.status === 'error' ? result.message : undefined)
    if (blocked) {
      for (const rest of scheduled.slice(index + 1)) await finishCheckpoint(host, rest, 'skipped', '写权限违规，后续检查未执行')
      ns.result = { pass: false, checks }
      await host.emit('gate.result', { pass: false, checks }, node.id)
      throw blocked
    }
    if (host.signal.aborted) {
      for (const rest of scheduled.slice(index + 1)) await finishCheckpoint(host, rest, 'skipped', '运行取消，检查未执行')
      await host.emit('gate.result', { pass: false, checks }, node.id)
      host.signal.throwIfAborted()
    }
  }
  host.signal.throwIfAborted()
  const pass = checks.every((check) => check.pass)
  ns.result = { pass, checks }
  await host.emit('gate.result', { pass, checks }, node.id)
  if (!pass) {
    for (const check of checks.filter((check) => !check.pass)) {
      if (await host.noteFailure(entry, `gate:${check.id}`, check.id, check.message)) return
    }
    if (node.onFail === 'human') await host.request(entry, `门禁未通过，请裁决：${JSON.stringify(checks.filter((c) => !c.pass))}`, 'approve', undefined, true)
    else throw new FailureError(`门禁未通过：${checks.filter((check) => !check.pass).map((check) => `${check.id}: ${check.message ?? '失败'}`).join('; ')}`, 'gate', undefined, true)
  }

}
