import type { ReviewRecord, ReviewRound } from '../../types.js'

export interface ExistingIssue { key: string; reviewer: string; description: string; status: string }

export function existingIssues(rounds: ReviewRound[]): ExistingIssue[] {
  const issues = new Map<string, ExistingIssue>()
  for (const round of rounds) {
    for (const record of round.records) {
      for (const previous of record.previous ?? []) {
        const old = issues.get(previous.key)
        if (old?.reviewer === record.reviewer) old.status = previous.status
      }
      for (const issue of record.issues) if (issue.key) issues.set(issue.key, { key: issue.key, reviewer: record.reviewer, description: issue.description, status: 'still_open' })
    }
    for (const response of round.responses) {
      const key = round.records.find((record) => record.reviewer === response.reviewer)?.issues.find((issue) => issue.id === response.issueId)?.key
      const issue = key && issues.get(key)
      if (issue) issue.status = response.action === 'fixed' ? 'claimed_fixed' : response.action
    }
  }
  return [...issues.values()]
}

export function assignIssues(value: Pick<ReviewRecord, 'issues' | 'previous'>, existing: ExistingIssue[], reviewer: string, next: () => string): void {
  const known = new Map(existing.filter((issue) => issue.reviewer === reviewer).map((issue) => [issue.key, issue]))
  const seen = new Set<string>()
  value.issues = value.issues.filter((issue) => {
    if (issue.key?.trim()) {
      if (!known.has(issue.key)) throw new Error(`不能自造或引用其他评审者的问题 key：${issue.key}`)
      if (seen.has(issue.key)) return false
    } else issue.key = next()
    seen.add(issue.key)
    return true
  })
  const checked = new Set<string>()
  for (const item of value.previous ?? []) {
    if (!known.has(item.key) || checked.has(item.key)) throw new Error(`复查 key 必须是当前评审者已有问题且唯一：${item.key}`)
    if (item.status === 'resolved' && seen.has(item.key)) throw new Error(`同一问题不能同时 resolved 和仍被提出：${item.key}`)
    checked.add(item.key)
  }
  // 兼容旧适配器，但缺失复查绝不升级为 verified_fixed。
  value.previous ??= []
  for (const key of known.keys()) if (!checked.has(key)) value.previous.push({ key, status: 'not_checked', note: '评审者未提供明确复查结论' })
}
