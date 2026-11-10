import type { NodeContext } from '../../types.js'
import type { Entry } from '../graph.js'
import type { NodeHost } from './host.js'
import type { GateCheckResult, GateNodeDef } from '../../types.js'
import { isObject } from '../../insights/artifacts.js'
import { scheduleCheckpoint, finishCheckpoint, withCapture, rubricDuties } from '../checkpoints.js'
import { createSnapshot, artifactMaterials, snapshotPrompt } from '../snapshots.js'
import { checkAcceptance } from '../acceptance.js'
import { FailureError } from '../fingerprint.js'
import { BlockedError } from '../harness.js'
import { RUBRIC_SCHEMA } from './schemas.js'
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error)
const clip = (text: string, max: number) => text.length > max ? `${text.slice(0, max)}…` : text
const listIds = (ids: string[]) => `${ids.slice(0, 5).join('、')}${ids.length > 5 ? ` 等 ${ids.length} 条` : ''}`

/**
 * 门禁交人裁决时的提问：第几次检查、哪些检查没过、为什么，以及「通过 / 打回」各会怎样。
 * 只写要点（AC 编号、未通过用例按状态计数），完整明细留在 gate.result 事件和检查点里。
 */
export function gateAsk(node: GateNodeDef, failed: GateCheckResult[], attempt = 1): string {
  const lines = failed.map((result) => {
    const check = node.checks.find((item) => item.id === result.id)
    const name = check?.title ?? result.id
    const score = check?.kind === 'rubric' && typeof result.score === 'number' ? `（${result.score} 分，需 ${check.threshold}）` : ''
    const parts = [clip(result.message?.trim() || (result.status === 'error' ? '检查出错' : '未通过'), 400)]
    const acs = Array.isArray(result.details) ? result.details.filter(isObject).filter((item) => typeof item.ac === 'string' && item.pass === false) : []
    if (acs.length) {
      parts.push(`未通过的 AC：${listIds(acs.map((item) => item.ac as string))}`)
      // 一条用例可能覆盖多条 AC，按用例 ID 去重再计数
      const failing = new Map<string, string>()
      for (const item of acs) for (const c of Array.isArray(item.cases) ? item.cases.filter(isObject) : []) {
        if (c.pass !== true) failing.set(String(c.id), String(c.status ?? 'not_run'))
      }
      const counts = new Map<string, number>()
      for (const status of failing.values()) counts.set(status, (counts.get(status) ?? 0) + 1)
      if (counts.size) parts.push(`没过的用例：${[...counts].map(([status, n]) => `${status} ${n} 条`).join('、')}`)
    }
    return `· ${name}${score}：${parts.join('；')}`
  })
  return [
    `${node.title || node.id}${attempt > 1 ? `第 ${attempt} 次检查仍` : ''}未通过：`,
    ...lines,
    '通过：放行，继续后面的节点。打回：这一步记为失败，运行结束，之后可以在运行页重试。',
  ].join('\n')
}

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
    // 交人裁决的门禁：失败直接问一次「通过 / 打回」，不再叠加「同样的失败出现 N 次，再试一次？」那一问
    if (node.onFail === 'human') return host.request(entry, gateAsk(node, checks.filter((check) => !check.pass), ns.attempts), 'approve', undefined, true)
    for (const check of checks.filter((check) => !check.pass)) {
      if (await host.noteFailure(entry, `gate:${check.id}`, check.id, check.message)) return
    }
    throw new FailureError(`门禁未通过：${checks.filter((check) => !check.pass).map((check) => `${check.id}: ${check.message ?? '失败'}`).join('; ')}`, 'gate', undefined, true)
  }

}
