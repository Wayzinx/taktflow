import type { Usage } from '@taktflow/core'
import { describe, expect, it } from 'vitest'
import { addUsage } from './parse.js'

describe('共享用量累加', () => {
  it.each([false, true])('可选字段只在一侧提供时保留，输入不可变（交换顺序：%s）', reverse => {
    const reported = Object.freeze({ inputTokens: 10, outputTokens: 2, cachedTokens: 0, costUsd: 0.25 })
    const basic = Object.freeze({ inputTokens: 3, outputTokens: 1 })
    const [left, right]: [Usage, Usage] = reverse ? [basic, reported] : [reported, basic]
    const total = addUsage(left, right)
    expect(total).toEqual({ inputTokens: 13, outputTokens: 3, cachedTokens: 0, costUsd: 0.25, unpricedTokens: 4 })
    expect(total).not.toBe(left)
    expect(total).not.toBe(right)
  })

  it('连续累加保留缓存和费用，未报告的字段不编造零值', () => {
    const first: Usage = { inputTokens: 1, outputTokens: 2 }
    const second: Usage = { inputTokens: 3, outputTokens: 4 }
    const basic = addUsage(first, second)
    expect(basic).toEqual({ inputTokens: 4, outputTokens: 6 })
    expect(basic).not.toHaveProperty('cachedTokens')
    expect(basic).not.toHaveProperty('costUsd')
    const total = addUsage(
      addUsage(basic, { inputTokens: 2, outputTokens: 1, cachedTokens: 3, costUsd: 0.5 }),
      { inputTokens: 1, outputTokens: 0, cachedTokens: 2, costUsd: 0.25 },
    )
    expect(total).toEqual({ inputTokens: 7, outputTokens: 7, cachedTokens: 5, costUsd: 0.75, unpricedTokens: 10 })
    expect(basic).toEqual({ inputTokens: 4, outputTokens: 6 })
  })
})
