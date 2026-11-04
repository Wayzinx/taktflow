import { expect, it } from 'vitest'
import { addUsage } from './usage.js'
it('不可变累加，只有任一输入存在可选字段才输出该字段，包括零', () => {
  const a = Object.freeze({ inputTokens: 1, outputTokens: 2, cachedTokens: 0 })
  const b = Object.freeze({ inputTokens: 3, outputTokens: 4, costUsd: 0.5 })
  expect(addUsage(a, b)).toEqual({ inputTokens: 4, outputTokens: 6, cachedTokens: 0, costUsd: 0.5 })
  expect(addUsage({ inputTokens: 0, outputTokens: 0 }, { inputTokens: 2, outputTokens: 3 })).toEqual({ inputTokens: 2, outputTokens: 3 })
  expect(a).toEqual({ inputTokens: 1, outputTokens: 2, cachedTokens: 0 })
})
