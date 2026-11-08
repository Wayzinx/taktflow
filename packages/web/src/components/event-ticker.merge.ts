import type { EventEnvelope, EventPayloads } from '@taktflow/core'
import { actionKind } from '../lib/actions'

/** 滚动条只放最近这么多条；更早的去审计日志看。 */
export const KEEP = 30

/** 新到的事件并进最近列表：按 seq 去重、新的在前、只留 KEEP 条。 */
export function mergeRecent(prev: EventEnvelope[], incoming: EventEnvelope[]): EventEnvelope[] {
  const bySeq = new Map(prev.map((e) => [e.seq, e]))
  for (const e of incoming) bySeq.set(e.seq, e)
  return [...bySeq.values()].sort((a, b) => b.seq - a.seq).slice(0, KEEP)
}

export interface TickerRow {
  /** 最新的一条（新的在前）。 */
  e: EventEnvelope
  /** 合并进这一行的事件，新的在前；只有工具调用会多于 1 条。 */
  items: EventEnvelope[]
}

const toolOf = (e: EventEnvelope) => (e.type === 'harness.tool_call' ? (e.data as EventPayloads['harness.tool_call']) : undefined)

/** 同一节点连续、同动词的成功工具调用并成一行 ×N（docs/design/25 §1）；其它事件各占一行。 */
export function tickerRows(events: EventEnvelope[]): TickerRow[] {
  const rows: TickerRow[] = []
  for (const e of events) {
    const t = toolOf(e)
    const last = rows[rows.length - 1]
    const prev = last && toolOf(last.e)
    if (t && prev && last.e.nodeId === e.nodeId && t.ok !== false && prev.ok !== false && actionKind(t.tool) === actionKind(prev.tool)) last.items.push(e)
    else rows.push({ e, items: [e] })
  }
  return rows
}
