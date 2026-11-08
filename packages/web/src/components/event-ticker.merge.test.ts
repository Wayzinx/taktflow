import { describe, expect, it } from 'vitest'
import type { EventEnvelope } from '@taktflow/core'
import { KEEP, mergeRecent, tickerRows } from './event-ticker.merge'

const ev = (seq: number) => ({ seq, type: 'log', at: '', actor: { type: 'system', id: 's' }, data: {} }) as unknown as EventEnvelope

describe('mergeRecent', () => {
  it('puts newer events first and de-duplicates by seq', () => {
    expect(mergeRecent([ev(3), ev(2)], [ev(3), ev(4), ev(5)]).map((e) => e.seq)).toEqual([5, 4, 3, 2])
  })
  it('keeps only the latest KEEP entries', () => {
    const prev = Array.from({ length: KEEP }, (_, i) => ev(KEEP - i))
    const out = mergeRecent(prev, [ev(KEEP + 1), ev(KEEP + 2)])
    expect(out).toHaveLength(KEEP)
    expect(out[0]!.seq).toBe(KEEP + 2)
    expect(out[out.length - 1]!.seq).toBe(3)
  })
})

const tool = (seq: number, nodeId: string, tool: string, ok = true) => ({ seq, nodeId, type: 'harness.tool_call', at: '', actor: { type: 'agent', id: 'a' }, data: { tool, input: `f${seq}.ts`, ok } }) as unknown as EventEnvelope

describe('tickerRows', () => {
  it('同节点连续同动词的工具调用并成一行，失败与跨节点的不并', () => {
    const rows = tickerRows([tool(6, 'dev', 'Read'), tool(5, 'dev', 'read_file'), tool(4, 'dev', 'Bash', false), tool(3, 'dev', 'Bash', false), tool(2, 'test', 'Read'), ev(1)])
    expect(rows.map((r) => r.items.map((e) => e.seq))).toEqual([[6, 5], [4], [3], [2], [1]])
  })
})
