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
it('新增重大问题阻止早停，轻微问题不延长预算，通过轮打断窗口', () => {
  const first = round([issue]); first.continuity = reviewContinuity(first)
  const next = round([issue]); next.continuity = reviewContinuity(next, first)
  const third = round([issue, { ...issue, id: 'nit', title: '拼写', severity: 'nit' }]); third.continuity = reviewContinuity(third, next)
  expect(noReviewProgress([first, next])).toBe(false)
  expect(noReviewProgress([first, next, third])).toBe(true)
  expect(noReviewProgress([first, next, third], 0)).toBe(false)
  third.passed = true
  expect(noReviewProgress([first, next, third])).toBe(false)
})
it.each(['deferred', 'declined'] as const)('同 key 问题改写标题、位置和措辞，作者 %s 后仍无进展', action => {
  const first = round([{ ...issue, key: 'ISS-1' }])
  first.responses = [{ round: 1, reviewer: 'qa', issueId: 'I1', action, note: '需要 Lead 提供依据' }]
  const next = round([{ ...issue, key: 'ISS-1', title: '另一种表述', location: 'other.ts:8', description: '改写问题描述' }])
  next.continuity = reviewContinuity(next, first)
  expect(next.continuity).toMatchObject([{ observation: 'repeated', prevIssueId: 'I1' }])
  expect(next.records[0]!.issues[0]!.fingerprint).not.toBe(identifyIssue(first.records[0]!.issues[0]!).fingerprint)
  expect(noReviewProgress([first, next], 1)).toBe(true)
})
it('问题键不同但 groupKey 相同，deferred 后改写描述仍无进展', () => {
  const first = round([{ ...issue, key: 'ISS-1' }])
  first.responses = [{ round: 1, reviewer: 'qa', issueId: 'I1', action: 'deferred', note: '暂缓' }]
  const next = round([{ ...issue, key: 'ISS-2', description: '重新措辞' }])
  next.continuity = reviewContinuity(next, first)
  expect(next.continuity).toMatchObject([{ observation: 'repeated' }])
  expect(next.continuity).toHaveLength(1)
  expect(noReviewProgress([first, next], 1)).toBe(true)
})
it('保留已分配的 groupKey，无 key 的历史问题改写标题也保持延续', () => {
  const first = round([{ ...issue, groupKey: 'stable' }])
  first.responses = [{ round: 1, reviewer: 'qa', issueId: 'I1', action: 'deferred', note: '暂缓' }]
  const next = round([{ ...issue, groupKey: 'stable', title: '改写标题', description: '改写描述' }])
  next.continuity = reviewContinuity(next, first)
  expect(next.continuity).toMatchObject([{ groupKey: 'stable', observation: 'repeated' }])
  expect(noReviewProgress([first, next], 1)).toBe(true)
})
it('作者 fixed 后重大问题消失算进展；未修复问题消失不算进展', () => {
  const first = round([issue])
  first.responses = [{ round: 1, reviewer: 'qa', issueId: 'I1', action: 'fixed', note: '已修' }]
  const next = round([{ ...issue, id: 'nit', title: '拼写', severity: 'nit' }])
  next.continuity = reviewContinuity(next, first)
  expect(noReviewProgress([first, next], 1)).toBe(false)
  first.responses[0]!.action = 'deferred'
  expect(noReviewProgress([first, next], 1)).toBe(true)
})
it('新出现 major 算进展，同一未关闭 major 改写措辞不算进展', () => {
  const first = round([issue])
  const next = round([{ ...issue, description: '措辞改变' }, { ...issue, id: 'new', title: '新安全问题' }])
  next.continuity = reviewContinuity(next, first)
  expect(noReviewProgress([first, next], 1)).toBe(false)
  next.records[0]!.issues.pop()
  next.continuity = reviewContinuity(next, first)
  expect(noReviewProgress([first, next], 1)).toBe(true)
})
it('既有 minor 升为 major 算新增重大问题；fixed 后同一问题改写也不算修复进展', () => {
  const first = round([{ ...issue, key: 'ISS-1', severity: 'minor' }])
  const next = round([{ ...issue, key: 'ISS-1', description: '升级为重大问题' }])
  next.continuity = reviewContinuity(next, first)
  expect(noReviewProgress([first, next], 1)).toBe(false)
  first.records[0]!.issues[0]!.severity = 'major'
  first.responses = [{ round: 1, reviewer: 'qa', issueId: 'I1', action: 'fixed', note: '声称已修' }]
  next.continuity = reviewContinuity(next, first)
  expect(next.continuity).toMatchObject([{ observation: 'changed' }])
  expect(noReviewProgress([first, next], 1)).toBe(true)
})
