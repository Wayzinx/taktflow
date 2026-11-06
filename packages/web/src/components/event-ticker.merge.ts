import type { EventEnvelope } from '@taktflow/core'

/** 滚动条只放最近这么多条；更早的去审计日志看。 */
export const KEEP = 30

/** 新到的事件并进最近列表：按 seq 去重、新的在前、只留 KEEP 条。 */
export function mergeRecent(prev: EventEnvelope[], incoming: EventEnvelope[]): EventEnvelope[] {
  const bySeq = new Map(prev.map((e) => [e.seq, e]))
  for (const e of incoming) bySeq.set(e.seq, e)
  return [...bySeq.values()].sort((a, b) => b.seq - a.seq).slice(0, KEEP)
}
