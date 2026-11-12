import type { NodeScorecard } from '@taktflow/core'

export type SortKey = 'executions' | 'firstPassRate' | 'escapes' | 'detection' | 'cost' | 'none'

const sortValue = (c: NodeScorecard, k: SortKey): number =>
  k === 'executions' ? c.executions : k === 'firstPassRate' ? (c.firstPassRate ?? -1) : k === 'escapes' ? c.escapes : k === 'detection' ? (c.detection?.rate ?? -1) : 0

/** 成本未上报（undefined）不是 0：按成本排序时无论升降序都排在最后。 */
export function sortScorecards(cards: NodeScorecard[], k: SortKey, desc: boolean): NodeScorecard[] {
  if (k === 'none') return cards
  if (k === 'cost')
    return [...cards].sort((a, b) => {
      const x = a.usage.costUsd
      const y = b.usage.costUsd
      if (x === undefined || y === undefined) return x === undefined ? (y === undefined ? 0 : 1) : -1
      return (x - y) * (desc ? -1 : 1)
    })
  return [...cards].sort((a, b) => (sortValue(a, k) - sortValue(b, k)) * (desc ? -1 : 1))
}
