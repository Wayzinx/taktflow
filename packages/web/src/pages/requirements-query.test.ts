import { expect, it } from 'vitest'
import type { RequirementSummary } from '@taktflow/core'
import { readView, sortPatch, sortRequirements } from './requirements-query'

const req = (id: string, patch: Partial<RequirementSummary> = {}): RequirementSummary => ({
  id, title: id, status: 'active', createdAt: '', updatedAt: '2026-11-01T00:00:00Z', stages: [], pendingAttention: 0, usage: { inputTokens: 0, outputTokens: 0 }, ...patch,
} as RequirementSummary)

it('筛选与排序从 URL 读出，未知值回到默认', () => {
  expect(readView(new URLSearchParams('status=draft&mine=1&q=导出&sort=tokens'))).toEqual({ filter: 'draft', mine: true, text: '导出', sort: 'tokens', order: 'desc' })
  expect(readView(new URLSearchParams('status=bogus&sort=bogus'))).toEqual({ filter: 'all', mine: false, text: '', sort: undefined, order: 'asc' })
})

it('点表头：换列用默认方向，同列再点反过来；默认方向不写进 URL', () => {
  const view = readView(new URLSearchParams(''))
  expect(sortPatch(view, 'tokens')).toEqual({ sort: 'tokens', order: undefined })
  expect(sortPatch(readView(new URLSearchParams('sort=tokens')), 'tokens')).toEqual({ sort: 'tokens', order: 'asc' })
  expect(sortPatch(readView(new URLSearchParams('sort=id')), 'id')).toEqual({ sort: 'id', order: 'desc' })
})

it('按 Token、拦截排序；成本未上报的无论升降序都排在最后', () => {
  const rows = [
    req('REQ-1', { usage: { inputTokens: 20_000, outputTokens: 9000, costUsd: 0.04 }, quality: { verified: 1, intercepted: 9, interceptedBy: { gate: 0, review: 9, judge: 0, completion: 0, fingerprint: 0 } } }),
    req('REQ-2'),
    req('REQ-3', { usage: { inputTokens: 7_000_000, outputTokens: 3_000_000 }, quality: { verified: 17, intercepted: 79, interceptedBy: { gate: 0, review: 79, judge: 0, completion: 0, fingerprint: 0 } } }),
  ]
  expect(sortRequirements(rows, 'tokens', 'desc').map((r) => r.id)).toEqual(['REQ-3', 'REQ-1', 'REQ-2'])
  expect(sortRequirements(rows, 'intercepted', 'desc').map((r) => r.id)).toEqual(['REQ-3', 'REQ-1', 'REQ-2'])
  expect(sortRequirements(rows, 'cost', 'desc').map((r) => r.id)).toEqual(['REQ-1', 'REQ-2', 'REQ-3'])
  expect(sortRequirements(rows, 'cost', 'asc').map((r) => r.id)).toEqual(['REQ-1', 'REQ-2', 'REQ-3'])
  expect(sortRequirements(rows, undefined, 'asc')).toBe(rows)
})
