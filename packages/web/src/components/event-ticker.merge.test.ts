import { describe, expect, it } from 'vitest'
import type { EventEnvelope } from '@taktflow/core'
import { KEEP, mergeRecent } from './event-ticker.merge'

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
