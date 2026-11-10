import { expect, it } from 'vitest'
import { briefError, briefReviewFeedback, judgeAsk } from './brief.js'

it('报错是 harness 结果 JSON 时取类型和说明，不贴整段 JSON', () => {
  expect(briefError('{"type":"result","subtype":"error_max_turns","duration_api_ms":0,"result":"已达到最大轮次"}')).toBe('error_max_turns：已达到最大轮次')
  expect(briefError('{"error":{"message":"rate limited"}}')).toBe('rate limited')
  expect(briefError('普通报错\n第二行')).toBe('普通报错 第二行')
  expect(briefError('x'.repeat(300))).toBe(`${'x'.repeat(200)}…`)
})

it('打回重做的评审意见只说第几轮、几位评审、几个问题', () => {
  const feedback = JSON.stringify({ round: 3, records: [
    { reviewer: 'architect', summary: '很长的总结', issues: [{ id: 'A1', severity: 'major' }, { id: 'A2', severity: 'minor' }] },
    { reviewer: 'qa', issues: [{ id: 'B1', severity: 'major' }] },
  ] })
  expect(briefReviewFeedback(feedback)).toBe('第 3 轮评审：2 位评审提了 3 个问题（major 2、minor 1）。')
  expect(briefReviewFeedback('请补充边界条件')).toBe('请补充边界条件')
})

it('判决交人：每条一行写对象、类别和理由，超过 6 条只列前 6 条', () => {
  const verdicts = Array.from({ length: 8 }, (_, i) => ({ subject: `TC-${i + 1}`, category: 'requirement_gap' as const, confidence: 0.8, rationale: `理由 ${i + 1}`, evidence: [] }))
  const lines = judgeAsk('失败判决', verdicts).split('\n')
  expect(lines[0]).toBe('失败判决有 8 条判决需要你裁决：')
  expect(lines[1]).toBe('· TC-1 · 需求缺口：理由 1')
  expect(lines).toContain('…等 8 条，完整判决见判决产物')
  expect(lines.at(-1)).toMatch(/^通过：/)
  expect(lines.join('\n')).not.toContain('"subject"')
})
