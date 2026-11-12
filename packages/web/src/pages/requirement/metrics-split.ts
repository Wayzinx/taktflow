import type { GraphNode, Usage } from '@taktflow/core'
import { totalTokens } from '../../lib/format'

/** 需求度量 Tab 的 token 拆分。 */

export function sumBy(nodes: GraphNode[], key: (n: GraphNode) => string | undefined): Array<[string, Usage]> {
  const m = new Map<string, Usage>()
  for (const n of nodes) {
    if (!n.usage) continue
    const k = key(n)
    if (k === undefined) continue
    const u = m.get(k) ?? { inputTokens: 0, outputTokens: 0 }
    // 没有任何节点上报成本时保持 undefined，fmtCost 显示“—”而不是“<$0.01”
    const costUsd = u.costUsd === undefined && n.usage.costUsd === undefined ? undefined : (u.costUsd ?? 0) + (n.usage.costUsd ?? 0)
    m.set(k, { inputTokens: u.inputTokens + n.usage.inputTokens, outputTokens: u.outputTokens + n.usage.outputTokens, costUsd })
  }
  return [...m.entries()].sort((a, b) => totalTokens(b[1]) - totalTokens(a[1]))
}

/**
 * 按 harness 拆分需求总 token。多评审人的评审节点、门禁等没有单一 harness，和没落到节点上的用量一起归“未记录”；
 * 占比以需求总量为分母，不把已记录的部分放大成 100%；0 token 的 harness 不列。
 */
export function harnessSplit(nodes: GraphNode[], total: number) {
  const recorded = sumBy(nodes, (n) => n.harness).filter(([, u]) => totalTokens(u) > 0)
  const known = recorded.reduce((s, [, u]) => s + totalTokens(u), 0)
  const unrecorded = Math.max(0, total - known)
  const rows: Array<{ key: string; tokens: number; unknown?: boolean }> = recorded.map(([key, u]) => ({ key, tokens: totalTokens(u) }))
  if (known > 0 && unrecorded > 0) rows.push({ key: '未记录 harness', tokens: unrecorded, unknown: true })
  return { rows, known, denominator: Math.max(total, known) }
}
