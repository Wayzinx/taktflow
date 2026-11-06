import type { Actor, EventEnvelope, EventPayloads, EventType } from '@taktflow/core'
import type { MockRun } from './mock-data'

export interface RawEvent<T extends EventType = EventType> {
  ts: string
  nodeId?: string
  type: T
  actor: Actor
  data: EventPayloads[T]
}

export const ENGINE: Actor = { type: 'system', id: 'engine' }

export function ev<T extends EventType>(ts: string, type: T, actor: Actor, data: EventPayloads[T], nodeId?: string): RawEvent {
  return { ts, type, actor, data, nodeId } as RawEvent
}

/** 把补充事件按时间插入运行事件流，并重排 seq 与哈希链（演示用的假哈希）。 */
export function insertRunEvents(run: MockRun, items: RawEvent[]): void {
  if (!items.length) return
  const all = [...run.events, ...items.map((x) => ({ ...x, runId: run.state.runId, seq: 0, prevHash: '', hash: '' }) as EventEnvelope)]
  all.sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts))
  let prev = '0'.repeat(64)
  all.forEach((e, i) => {
    e.seq = i + 1
    e.prevHash = prev
    e.hash = prev = (prev.slice(8) + e.seq.toString(16).padStart(8, '0')).slice(-64)
  })
  run.events = all
}

export const shift = (iso: string, ms: number) => new Date(Date.parse(iso) + ms).toISOString()
