import { expect, it } from 'vitest'
import type { KnowledgeEvalCase, KnowledgeHit } from '@taktflow/core'
import { answerMatches, compare, diagnose, metrics, wilson, type Observation } from './metrics.js'
const test: KnowledgeEvalCase = {
  id: 'c',
  query: 'q',
  relevant: [
    { ref: 'a', grade: 3 },
    { ref: 'b', grade: 2 },
    { ref: 'c', grade: 1 },
  ],
  createdAt: '',
  createdBy: { type: 'human', id: 't' },
  status: 'active',
  source: 'manual',
}
const hit = (ref: string): KnowledgeHit => ({ ref, sourceId: 'kb', title: ref, snippet: ref })
const row = (hits: string[], latencyMs = 10): Observation => ({
  test,
  hits: hits.map(hit),
  topK: 5,
  latencyMs,
  tokens: 12,
})
it('召回、精度、分级 nDCG、MRR、命中、空结果与最近秩延迟均对照手算', () => {
  const result = metrics([row(['x', 'a', 'b', 'y', 'z', 'c'], 10), row([], 30)], 'rag')
  expect(result.recall5).toBeCloseTo(1 / 3)
  expect(result.recall10).toBe(0.5)
  expect(result.precision5).toBe(0.2)
  expect(result.mrr).toBe(0.25)
  const dcg = 7 / Math.log2(3) + 3 / Math.log2(4) + 1 / Math.log2(7)
  expect(result.ndcg10).toBeCloseTo(dcg / (7 + 3 / Math.log2(3) + 1 / Math.log2(4)) / 2)
  expect(result).toMatchObject({
    n: 2,
    hitRate: 0.5,
    emptyRate: 0.5,
    latencyP50: 10,
    latencyP95: 30,
    tokensPerQuery: 12,
  })
  expect(metrics([], 'rag')).toMatchObject({ n: 0, recall10: 0, emptyRate: 0, latencyP50: 0 })
})
it('重复命中不会重复计算相关性', () => {
  expect(metrics([row(['a', 'a', 'a'])], 'rag')).toMatchObject({ recall10: 1 / 3, precision5: 0.2 })
})
it.each([
  [['a'], 1, [], 'ok'],
  [['x', 'a'], 1, [], 'low_rank'],
  [['x'], 1, ['a'], 'not_retrieved'],
  [['x'], 1, [], 'no_doc'],
] as const)('诊断 %s', (refs, topK, index, expected) => {
  expect(diagnose(test, refs.map(hit), topK, new Set(index))).toBe(expected)
})
it('Wilson 与成对比较方向、小样本和全平局', () => {
  expect(wilson(5, 10)[0]).toBeCloseTo(0.236593, 5)
  expect(wilson(5, 10)[1]).toBeCloseTo(0.763407, 5)
  expect(wilson(0, 0)).toEqual([0, 1])
  expect(compare('a', 'b', Array(5).fill(0), Array(5).fill(1))).toMatchObject({
    wins: 5,
    losses: 0,
    ties: 0,
    verdict: 'better',
    recall10Delta: 1,
  })
  expect(compare('a', 'b', Array(5).fill(1), Array(5).fill(0)).verdict).toBe('worse')
  expect(compare('a', 'b', [0, 0, 0, 0], [1, 1, 1, 1]).verdict).toBe('inconclusive')
  expect(compare('a', 'b', [1, 1], [1, 1]).verdict).toBe('same')
  expect(compare('a', 'b', [0, 1, 0, 1, 0, 1], [1, 0, 1, 0, 1, 0]).verdict).toBe('inconclusive')
})
it('数据库分母只包含 SQL，正确性按期望关键字段比较；拦截和执行错误均不成功', () => {
  const success = {
    ...row([]),
    hits: [{ ...hit('sql'), snippet: '{"total":12,"state":"ready"}' }],
    test: { ...test, answer: '{"total":12}' },
    executed: { kind: 'sql' as const, text: 'SELECT' },
  }
  const blocked = { ...success, hits: [], executed: { ...success.executed, blocked: '只读' } }
  const failed = { ...success, hits: [], failed: true }
  expect(metrics([success, blocked, failed, row(['a'])], 'database')).toMatchObject({
    sqlSuccess: 1 / 3,
    resultAccuracy: 1 / 3,
    blocked: 1,
  })
  expect(answerMatches('{"total":1}', success.hits)).toBe(false)
  expect(answerMatches('[{"state":"ready"}]', success.hits)).toBe(true)
  expect(answerMatches('ready;12', success.hits)).toBe(true)
  expect(answerMatches('[]', success.hits)).toBe(false)
  expect(answerMatches('12', success.hits)).toBe(true)
  expect(answerMatches('1', success.hits)).toBe(false)
  expect(
    metrics([{ ...success, hits: [], test: { ...test, answer: '[]' } }], 'database').resultAccuracy,
  ).toBe(1)
})
it('接口操作选择用首位命中，调用成功率只统计实际调用', () => {
  expect(
    metrics(
      [
        row(['a']),
        { ...row(['x']), executed: { kind: 'http', text: 'GET /x' } },
        { ...row([]), executed: { kind: 'http', text: 'POST /x', blocked: '只允许 GET' } },
      ],
      'api',
    ),
  ).toMatchObject({ opAccuracy: 1 / 3, callSuccess: 0.5 })
})
