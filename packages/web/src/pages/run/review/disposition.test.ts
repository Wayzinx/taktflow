import { describe, expect, it } from 'vitest'
import type { ReviewDisposition } from '@taktflow/core'
import { effectiveDisposition } from './disposition'

const d = (groupKey: string, state: ReviewDisposition['state'], fingerprint?: string): ReviewDisposition => ({ groupKey, state, fingerprint, reason: state, by: { type: 'human', id: 'a' }, at: '2026-11-06T00:00:00Z' }) as ReviewDisposition

describe('effectiveDisposition', () => {
  it('returns nothing without a group key or list', () => {
    expect(effectiveDisposition(undefined, 'g', 'f')).toEqual({ current: undefined, expired: undefined })
    expect(effectiveDisposition([d('g', 'resolved')], undefined, 'f')).toEqual({ current: undefined, expired: undefined })
  })
  it('uses the latest disposition for the group', () => {
    const list = [d('g', 'dismissed', 'f1'), d('h', 'resolved'), d('g', 'open', 'f1')]
    expect(effectiveDisposition(list, 'g', 'f1').current?.state).toBe('open')
  })
  it('expires a disposition whose fingerprint no longer matches', () => {
    const r = effectiveDisposition([d('g', 'resolved', 'f1')], 'g', 'f2')
    expect(r.current).toBeUndefined()
    expect(r.expired?.state).toBe('resolved')
  })
  it('keeps it when either fingerprint is unknown', () => {
    expect(effectiveDisposition([d('g', 'resolved')], 'g', 'f2').current?.state).toBe('resolved')
    expect(effectiveDisposition([d('g', 'resolved', 'f1')], 'g', undefined).current?.state).toBe('resolved')
  })
})
