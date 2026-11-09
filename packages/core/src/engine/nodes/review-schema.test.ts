import { expect, it } from 'vitest'
import type { ReviewRecord, ReviewResponse } from '../../types.js'
import { assertResponses, normalizeResponses } from './review-schema.js'

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
