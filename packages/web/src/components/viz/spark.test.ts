import { expect, it } from 'vitest'
import { barHeight } from './spark'

it('运行迷你柱用对数刻度：15 万 token 的失败运行和 2.6 万的看得出差别，不被 10M 的压成同一高度（TF-092）', () => {
  const max = 10_140_378
  const h = (t: number) => barHeight(t, max, 14)
  expect(h(max)).toBe(14)
  expect(h(151_835)).toBeGreaterThan(h(26_449))
  expect(h(26_449)).toBeGreaterThan(3)
  expect(h(1000)).toBe(3)
  expect(h(0)).toBe(0)
})
