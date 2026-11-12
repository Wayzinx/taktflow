import { expect, it } from 'vitest'
import type { EventEnvelope } from '../types.js'
import { addUsage, summarizeUsage } from './usage.js'
it('不可变累加，只有任一输入存在可选字段才输出该字段，包括零', () => {
  const a = Object.freeze({ inputTokens: 1, outputTokens: 2, cachedTokens: 0 })
  const b = Object.freeze({ inputTokens: 3, outputTokens: 4, costUsd: 0.5 })
  expect(addUsage(a, b)).toEqual({ inputTokens: 4, outputTokens: 6, cachedTokens: 0, costUsd: 0.5, unpricedTokens: 3 })
  expect(addUsage({ inputTokens: 0, outputTokens: 0 }, { inputTokens: 2, outputTokens: 3 })).toEqual({ inputTokens: 2, outputTokens: 3 })
  expect(addUsage({ inputTokens: 0, outputTokens: 0, costUsd: 0 }, { inputTokens: 0, outputTokens: 0, costUsd: 0 })).toEqual({ inputTokens: 0, outputTokens: 0, costUsd: 0 })
  expect(a).toEqual({ inputTokens: 1, outputTokens: 2, cachedTokens: 0 })
})
it('有 token 的调用都没报成本时成本是未知，零用量调用带的 costUsd: 0 不算 $0', () => {
  const free = { inputTokens: 0, outputTokens: 0, costUsd: 0 }
  const unpriced = { inputTokens: 7_000_000, outputTokens: 3_000_000 }
  expect(addUsage(free, unpriced)).toEqual(unpriced)
  expect(addUsage(addUsage(unpriced, free), free)).toEqual(unpriced)
})
it('部分报了成本：costUsd 只是报了的部分，unpricedTokens 跟着累加', () => {
  const priced = { inputTokens: 100, outputTokens: 20, costUsd: 0.04 }
  const partial = addUsage(priced, { inputTokens: 900, outputTokens: 80 })
  expect(partial).toEqual({ inputTokens: 1000, outputTokens: 100, costUsd: 0.04, unpricedTokens: 980 })
  expect(addUsage(partial, { inputTokens: 5000, outputTokens: 0 })).toEqual({ inputTokens: 6000, outputTokens: 100, costUsd: 0.04, unpricedTokens: 5980 })
  expect(addUsage(partial, priced)).toEqual({ inputTokens: 1100, outputTokens: 120, costUsd: 0.08, unpricedTokens: 980 })
})
it('summarizeUsage：失败的零用量调用报了 $0、其余调用没报成本时，不输出 costUsd', () => {
  const event = (seq: number, data: object): EventEnvelope => ({ seq, runId: 'r', ts: '', type: 'harness.usage', actor: { type: 'system', id: 'engine' }, data } as unknown as EventEnvelope)
  expect(summarizeUsage([event(1, { inputTokens: 0, outputTokens: 0, costUsd: 0 }), event(2, { inputTokens: 26_000, outputTokens: 449 })])).toEqual({ inputTokens: 26_000, outputTokens: 449 })
})
it('零 Token 但明确上报的非零费用仍累计，与累加顺序无关', () => {
  const charge = { inputTokens: 0, outputTokens: 0, costUsd: 0.2 }
  const unknown = { inputTokens: 100, outputTokens: 20 }
  const expected = { ...unknown, costUsd: 0.2, unpricedTokens: 120 }
  expect(addUsage(charge, unknown)).toEqual(expected)
  expect(addUsage(unknown, charge)).toEqual(expected)
  expect(addUsage({ inputTokens: 0, outputTokens: 0 }, charge)).toEqual(charge)
})
