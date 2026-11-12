import { describe, expect, it } from 'vitest'
import type { NodeScorecard } from '@taktflow/core'
import { sortScorecards } from './scorecard-sort'

const card = (label: string, costUsd?: number): NodeScorecard => ({
  key: { by: 'node', nodeId: label },
  label,
  executions: 0,
  review: { reworks: 0, issues: { blocker: 0, major: 0, minor: 0, nit: 0 } },
  humanEdits: { cosmetic: 0, semantic: 0 },
  completionUnmet: 0,
  suppressed: 0,
  downstream: {},
  escapes: 0,
  usage: { inputTokens: 0, outputTokens: 0, costUsd },
})

const labels = (cards: NodeScorecard[]) => cards.map((c) => c.label)

describe('sortScorecards', () => {
  it('成本未上报不按 0 排，升降序都排在最后', () => {
    const cards = [card('未知'), card('便宜', 0.1), card('贵', 2)]
    expect(labels(sortScorecards(cards, 'cost', false))).toEqual(['便宜', '贵', '未知'])
    expect(labels(sortScorecards(cards, 'cost', true))).toEqual(['贵', '便宜', '未知'])
  })

  it('多个未上报之间保持原顺序', () => {
    const cards = [card('未知甲'), card('贵', 2), card('未知乙')]
    expect(labels(sortScorecards(cards, 'cost', true))).toEqual(['贵', '未知甲', '未知乙'])
  })

  it('其他列仍按数值升降序', () => {
    const a = { ...card('a'), executions: 1 }
    const b = { ...card('b'), executions: 3 }
    expect(labels(sortScorecards([a, b], 'executions', false))).toEqual(['a', 'b'])
    expect(labels(sortScorecards([a, b], 'executions', true))).toEqual(['b', 'a'])
  })
})
