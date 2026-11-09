import type { ReviewNodeDef, ReviewRecord, ReviewResponse } from '../../types.js'

export const REVIEW_SCHEMA = {
  type: 'object', required: ['verdict', 'summary', 'issues'], properties: {
    verdict: { type: 'string', enum: ['approve', 'request_changes', 'reject'] }, score: { type: 'number' }, summary: { type: 'string' },
    checklist: { type: 'array', items: { type: 'object', required: ['item', 'status'], properties: { item: { type: 'string' }, status: { type: 'string', enum: ['ok', 'issue', 'na'] }, issues: { type: 'array', items: { type: 'string' } }, note: { type: 'string' } } } },
    previous: { type: 'array', items: { type: 'object', required: ['key', 'status'], properties: { key: { type: 'string' }, status: { type: 'string', enum: ['resolved', 'still_open', 'not_checked'] }, note: { type: 'string' } } } },
    issues: { type: 'array', items: { type: 'object', required: ['id', 'severity', 'description'], properties: {
      key: { type: 'string' }, duty: { type: 'string' }, id: { type: 'string' }, severity: { type: 'string', enum: ['blocker', 'major', 'minor', 'nit'] },
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

export function reviewPassed(records: ReviewRecord[], pass: ReviewNodeDef['pass'] = 'all'): boolean {
  if (!records.length) return false
  if (typeof pass === 'object') return records.every((record) => record.verdict !== 'reject' && record.score !== undefined && record.score >= pass.minScore)
  const approvals = records.filter((record) => record.verdict === 'approve').length
  return pass === 'majority' ? approvals > records.length / 2 : approvals === records.length
}

/**
 * 作者常照着全局编号（issue.key，如 ISS-36）回应，或照抄上一轮的轮次：按本轮问题把 issueId 归一到评审人给的 id，
 * reviewer 写错时用全局编号找回，轮次统一成本轮。找不到的原样留给 assertResponses 报错。
 */
export function normalizeResponses(records: ReviewRecord[], responses: ReviewResponse[], round: number): ReviewResponse[] {
  return responses.map((response) => {
    const own = records.find((record) => record.reviewer === response.reviewer)
    if (own?.issues.some((issue) => issue.id === response.issueId)) return { ...response, round }
    for (const record of own ? [own, ...records.filter((r) => r !== own)] : records) {
      const issue = record.issues.find((issue) => issue.key !== undefined && issue.key === response.issueId)
      if (issue) return { ...response, round, reviewer: record.reviewer, issueId: issue.id }
    }
    return { ...response, round }
  })
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
