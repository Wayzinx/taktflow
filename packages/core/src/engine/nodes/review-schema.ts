import type { ReviewNodeDef, ReviewRecord, ReviewResponse } from '../../types.js'

export const REVIEW_SCHEMA = {
  type: 'object', required: ['verdict', 'summary', 'issues'], properties: {
    verdict: { type: 'string', enum: ['approve', 'request_changes', 'reject'] }, score: { type: 'number' }, summary: { type: 'string' },
    issues: { type: 'array', items: { type: 'object', required: ['id', 'severity', 'description'], properties: {
      id: { type: 'string' }, severity: { type: 'string', enum: ['blocker', 'major', 'minor', 'nit'] },
      title: { type: 'string' }, category: { type: 'string' }, description: { type: 'string' }, location: { type: 'string' }, suggestion: { type: 'string' },
    } } },
  },
}
export const RESPONSES_SCHEMA = {
  type: 'object', required: ['responses'], properties: { responses: { type: 'array', items: {
    type: 'object', required: ['round', 'reviewer', 'issueId', 'action', 'note'], properties: {
      round: { type: 'integer' }, reviewer: { type: 'string' }, issueId: { type: 'string' },
      action: { type: 'string', enum: ['fixed', 'declined', 'deferred'] }, note: { type: 'string' },
    },
  } } },
}

/**
 * 复审轮次（第 2 轮起）只有 blocker / major 阻止通过：评审者给了 request_changes 但剩下的都是 minor / nit，
 * 按通过算。否则每轮都能挑出新的小问题，文档越改越长，评审永远收敛不了（真实事故：PRD 改到 v6、920 行）。
 * reject 和首轮不放宽。
 */
export function reviewApproves(record: ReviewRecord, round = 1): boolean {
  if (record.verdict === 'approve') return true
  if (record.verdict !== 'request_changes' || round < 2) return false
  return record.issues.every((issue) => issue.severity === 'minor' || issue.severity === 'nit')
}

export function reviewPassed(records: ReviewRecord[], pass: ReviewNodeDef['pass'] = 'all', round = 1): boolean {
  if (!records.length) return false
  if (typeof pass === 'object') return records.every((record) => record.verdict !== 'reject' && record.score !== undefined && record.score >= pass.minScore)
  const approvals = records.filter((record) => reviewApproves(record, round)).length
  return pass === 'majority' ? approvals > records.length / 2 : approvals === records.length
}

export function assertResponses(records: ReviewRecord[], responses: ReviewResponse[], round: number): void {
  const expected = new Set(records.flatMap((record) => record.issues.map((issue) => JSON.stringify([record.reviewer, issue.id]))))
  const seen = new Set<string>()
  for (const response of responses) {
    const key = JSON.stringify([response.reviewer, response.issueId])
    if (response.round !== round || !expected.has(key) || seen.has(key)) throw new Error(`作者回应必须与本轮问题逐条对应：${key}`)
    seen.add(key)
  }
  if (seen.size !== expected.size) throw new Error('作者回应缺少问题')
}
