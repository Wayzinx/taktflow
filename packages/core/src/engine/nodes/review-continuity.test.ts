import { expect, it } from 'vitest'
import type { ReviewIssue, ReviewRound } from '../../types.js'
import { identifyIssue, noReviewProgress, reviewContinuity } from './review-continuity.js'

const issue: ReviewIssue = { id: 'I1', location: 'SRC/Auth.ts:12:3', severity: 'major', category: 'security', title: '校验，Token！', description: '允许无效凭据' }
const round = (issues: ReviewIssue[]): ReviewRound => ({ round: 1, passed: false, records: [{ round: 1, reviewer: 'qa', verdict: 'request_changes', summary: '', issues, artifacts: [], at: '' }], responses: [], revised: [] })
it('行号与标题标点不改变分组；原始位置、严重度或描述改变指纹', () => {
  const before = identifyIssue(issue)
  const after = identifyIssue({ ...issue, location: 'src/auth.ts:25', title: '校验 Token', description: '允许空凭据' })
  expect(before.groupKey).toBe(after.groupKey)
  expect(before.fingerprint).not.toBe(after.fingerprint)
  expect(before.fingerprint).toHaveLength(16)
})
it('观察四种状态，fixed 仅触发回潮标记且不关闭问题', () => {
  const previous = round([issue, { ...issue, id: 'gone', title: '上轮问题' }])
  previous.responses = [{ round: 1, reviewer: 'qa', issueId: 'I1', action: 'fixed', note: '完成' }]
  const current = round([issue, { ...issue, id: 'new', title: '新问题' }])
  const observations = reviewContinuity(current, previous)
  expect(observations).toMatchObject([{ observation: 'repeated', regressed: true }, { observation: 'new' }, { observation: 'not_observed' }])
  expect(reviewContinuity(round([{ ...issue, description: '其他凭据也放行' }]), previous)[0]?.observation).toBe('changed')
})
it('新增或变化的重大问题阻止早停，轻微问题不延长预算，通过轮打断窗口', () => {
  const first = round([issue]); first.continuity = reviewContinuity(first)
  const next = round([issue]); next.continuity = reviewContinuity(next, first)
  const third = round([issue, { ...issue, id: 'nit', title: '拼写', severity: 'nit' }]); third.continuity = reviewContinuity(third, next)
  expect(noReviewProgress([first, next])).toBe(false)
  expect(noReviewProgress([first, next, third])).toBe(true)
  expect(noReviewProgress([first, next, third], 0)).toBe(false)
  third.passed = true
  expect(noReviewProgress([first, next, third])).toBe(false)
})
