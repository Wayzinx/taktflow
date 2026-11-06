import type { NodeContext } from '../../types.js'
import type { Entry } from '../graph.js'
import type { NodeHost } from './host.js'
import type { JudgeVerdict } from '../../types.js'
import { sha256 } from '../../util/hash.js'
import { system } from '../actor.js'
import { JUDGE_SCHEMA, assertVerdictsCover } from './schemas.js'

export async function run(host: NodeHost, entry: Entry, ctx: NodeContext): Promise<void> {
  const node = entry.def
  if (node.kind !== 'judge') throw new Error('内部错误：不是 judge')
  const ns = host.state.nodes[node.id]!
  const target = ctx.resultOf(node.target) as { failures?: Array<{ subject: string }> } | undefined
  const failures = target?.failures ?? []
  if (!Array.isArray(failures)) throw new Error('judge target.failures 必须是数组')
  let verdicts: JudgeVerdict[] = []
  if (failures.length) {
    const value = await host.model(entry, ctx, node.role, `判断以下失败的根因。输出 { verdicts: JudgeVerdict[] }，每个 subject 恰好一个判决：\n${JSON.stringify(failures)}`, JUDGE_SCHEMA) as { verdicts: JudgeVerdict[] }
    verdicts = value.verdicts
    assertVerdictsCover(failures, verdicts)
  }
  const routed: Record<string, string[]> = {}
  const routing: Array<{ subject: string; to: string }> = []
  let needsHuman = false
  for (const verdict of verdicts) {
    const to = node.routes[verdict.category] ?? 'human'
    routing.push({ subject: verdict.subject, to })
    if (to === 'human') needsHuman = true
    else if (to !== 'ignore') (routed[to] ??= []).push(verdict.subject)
  }
  for (const target of new Set(Object.values(node.routes))) {
    if (target === 'human' || target === 'ignore') continue
    const id = host.graph.has(entry.scope + target) ? entry.scope + target : target
    const child = host.graph.get(id)
    if (!child || !child.def.needs?.includes(node.id)) throw new Error(`判决路由目标必须依赖本节点：${target}`)
    if (!routed[target]?.length && host.state.nodes[id]!.status === 'pending') {
      await host.skipNode(id)
    }
  }
  ns.result = { verdicts, routed }
  // 没有失败就没有判决：不记 judge.verdict、不写判决产物（docs/dev/core-engine.md 的 judge 约定）
  if (!failures.length) return
  await host.emit('judge.verdict', { verdicts, routed: routing }, node.id)
  const path = `reports/verdicts/${host.state.runId}-${node.id}-${entry.iteration ?? 0}.json`
  const content = JSON.stringify(ns.result, null, 2)
  const ref = await host.guard.system(host.workspacePaths([path]), () => host.deps.stores.workspaces.writeArtifact({
    ref: { workspace: host.state.requirementId, path }, kind: 'verdict', content, author: system,
    derivedFrom: ns.inputs ?? [], producedBy: { runId: host.state.runId, nodeId: node.id }, reason: node.title,
  }))
  ns.outputs.push(ref)
  await host.emit('artifact.written', { ref, kind: 'verdict', sha256: sha256(content) }, node.id)
  // 修复节点会读取本轮判决，先登记产物再解析它的输入版本。
  for (const verdict of verdicts) {
    const to = node.routes[verdict.category] ?? 'human'
    const repair = host.graph.get(entry.scope + to) ?? host.graph.get(to)
    const source = repair ? await host.failureSource(repair) : ns
    if (await host.noteFailure(entry, `judge:${verdict.category}`, verdict.subject, verdict.rationale, source)) return
  }
  if (needsHuman) await host.request(entry, `失败判决需要人工裁决：${JSON.stringify(verdicts.filter((v) => (node.routes[v.category] ?? 'human') === 'human'))}`, 'approve')

}
