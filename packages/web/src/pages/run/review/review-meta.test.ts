import { describe, expect, it } from 'vitest'
import type { ReviewFacets } from '@taktflow/core'
import { outcomeView } from './review-meta'

const facets = (outcome: ReviewFacets['outcome'], open: Partial<ReviewFacets['open']> = {}): ReviewFacets => ({
  phase: 'done', outcome, coverage: 'full', freshness: 'current', open: { blocker: 0, major: 0, minor: 0, nit: 0, ...open },
})

describe('outcomeView', () => {
  it('keeps the plain outcome when nothing serious is open', () => {
    expect(outcomeView(facets('no_findings'))).toMatchObject({ label: '无问题', tone: 'success', leftover: 0 })
    expect(outcomeView(facets('no_findings', { minor: 2, nit: 1 }))).toMatchObject({ label: '无问题', tone: 'success', leftover: 0 })
    expect(outcomeView(facets(undefined))).toBeUndefined()
  })
  it('does not show a clean outcome while blocker / major issues are still open', () => {
    expect(outcomeView(facets('no_findings', { major: 1 }))).toMatchObject({ label: '本轮无新问题 · 遗留 1', tone: 'waiting', leftover: 1 })
    expect(outcomeView(facets('approved', { blocker: 1, major: 2 }))).toMatchObject({ label: '同意 · 遗留 3', tone: 'waiting', leftover: 3 })
  })
  it('leaves negative outcomes alone', () => {
    expect(outcomeView(facets('changes_requested', { major: 1 }))).toMatchObject({ label: '要求修改', leftover: 0 })
    expect(outcomeView(facets('rejected', { blocker: 1 }))).toMatchObject({ label: '否决', leftover: 0 })
  })
})
