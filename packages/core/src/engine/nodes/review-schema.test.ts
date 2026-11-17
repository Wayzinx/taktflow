import { expect, it } from 'vitest'
import type { ReviewRecord, ReviewResponse } from '../../types.js'
import { assertResponses, normalizeResponses, RESPONSES_SCHEMA } from './review-schema.js'
import { validateSchema } from '../schema.js'

const record = (reviewer: string, issues: Array<[string, string]>): ReviewRecord => ({
  round: 1, reviewer, verdict: 'request_changes', summary: '', artifacts: [], at: '2026-11-09T00:00:00.000Z',
  issues: issues.map(([id, key]) => ({ id, key, severity: 'minor', description: id })),
})
const records = [record('architect', [['A1', 'ISS-36'], ['A2', 'ISS-37']]), record('test-designer', [['N1', 'ISS-40']])]
const response = (reviewer: string, issueId: string, round = 1): ReviewResponse => ({ round, reviewer, issueId, action: 'fixed', note: '改了' })

it('作者用全局编号 ISS-n 回应时归一到评审人的 id（真实运行里 PM 这样回应导致整轮失败）', () => {
  const normalized = normalizeResponses(records, [response('architect', 'ISS-36'), response('architect', 'A2'), response('test-designer', 'ISS-40')], 1)
  expect(normalized.map((r) => [r.reviewer, r.issueId])).toEqual([['architect', 'A1'], ['architect', 'A2'], ['test-designer', 'N1']])
  expect(() => assertResponses(records, normalized, 1)).not.toThrow()
})

it('reviewer 写错但全局编号唯一时找回评审人；轮次统一成本轮', () => {
  const normalized = normalizeResponses(records, [response('architect', 'ISS-40', 3)], 2)
  expect(normalized[0]).toMatchObject({ reviewer: 'test-designer', issueId: 'N1', round: 2 })
})

it('对不上的回应原样留下，仍按原规则报错', () => {
  const normalized = normalizeResponses(records, [response('architect', 'ISS-99'), response('architect', 'A2'), response('test-designer', 'N1')], 1)
  expect(() => assertResponses(records, normalized, 1)).toThrow('作者回应必须与本轮问题逐条对应')
  expect(() => assertResponses(records, normalizeResponses(records, [response('architect', 'A1')], 1), 1)).toThrow('作者回应缺少问题')
})
it.each(['../other/ref.md', '/tmp/ref.md', 'manifest.json', 'ref\\outside.md'])('参考材料请求拒绝越界或元数据路径：%s', path => {
  expect(() => assertResponses([records[1]!], [{ ...response('test-designer', 'N1'), needsReferences: [path] }], 1)).toThrow()
})
it('参考材料 schema 接受路径或 glob，拒绝错误类型和超过单次上限；上限按全部回应合计', () => {
  const value = { responses: [{ ...response('test-designer', 'N1'), needsReferences: ['spec/prd.md', 'evidence/**'] }] }
  expect(() => validateSchema(value, RESPONSES_SCHEMA)).not.toThrow()
  expect(() => validateSchema({ responses: [{ ...response('test-designer', 'N1'), needsReferences: [3] }] }, RESPONSES_SCHEMA)).toThrow()
  const paths = Array.from({ length: 50 }, (_, index) => `refs/${index}.md`)
  expect(() => assertResponses([records[1]!], [{ ...response('test-designer', 'N1'), needsReferences: paths }], 1)).not.toThrow()
  expect(() => validateSchema({ responses: [{ ...response('test-designer', 'N1'), needsReferences: [...paths, 'more.md'] }] }, RESPONSES_SCHEMA)).toThrow()
  expect(() => assertResponses(records.slice(0, 1), [{ ...response('architect', 'A1'), needsReferences: paths },
    { ...response('architect', 'A2'), needsReferences: ['more.md'] }], 1)).toThrow('合计最多 50 条')
})
