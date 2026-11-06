import type { ReviewContinuity, ReviewIssue, ReviewRound } from '../../types.js'
import { sha256 } from '../../util/hash.js'

export function identifyIssue(issue: ReviewIssue): ReviewIssue & { groupKey: string; fingerprint: string } {
  const location = (issue.location ?? '').toLowerCase().replace(/(?::\d+(?::\d+)?(?:-\d+)?|#l\d+(?:-l?\d+)?)/g, '')
  const title = (issue.title ?? issue.description.slice(0, 40)).toLowerCase().replace(/[\p{P}\p{S}\s]/gu, '')
  return { ...issue, groupKey: `${location}:${issue.category ?? issue.severity}:${title}`,
    fingerprint: sha256(`${issue.location ?? ''}${issue.severity}${issue.description}`).slice(0, 16) }
}

export function reviewContinuity(round: ReviewRound, prior?: ReviewRound): ReviewContinuity[] {
  const previous = new Map((prior?.records ?? []).flatMap((record) => record.issues.map((issue) => {
    const identified = identifyIssue(issue)
    return [identified.groupKey, { issue: identified, reviewer: record.reviewer }] as const
  })))
  const observed = new Set<string>()
  const result: ReviewContinuity[] = []
  for (const record of round.records) {
    record.issues = record.issues.map(identifyIssue)
    for (const issue of record.issues) {
      const before = previous.get(issue.groupKey!)
      const observation = !before ? 'new' : before.issue.fingerprint === issue.fingerprint ? 'repeated' : 'changed'
      const fixed = before && prior?.responses.some((response) => response.reviewer === before.reviewer
        && response.issueId === before.issue.id && response.action === 'fixed')
      result.push({ groupKey: issue.groupKey!, issueId: issue.id, reviewer: record.reviewer,
        prevIssueId: before?.issue.id, observation, ...(observation === 'repeated' && fixed ? { regressed: true } : {}) })
      observed.add(issue.groupKey!)
    }
  }
  for (const [groupKey, before] of previous) if (!observed.has(groupKey)) {
    result.push({ groupKey, prevIssueId: before.issue.id, reviewer: before.reviewer, observation: 'not_observed' })
  }
  return result
}

export function noReviewProgress(rounds: ReviewRound[], limit = 2): boolean {
  if (limit === 0 || rounds.length < limit) return false
  return rounds.slice(-limit).every((round) => !round.passed && !(round.continuity ?? []).some((item) => {
    if (item.observation !== 'new' && item.observation !== 'changed') return false
    const issue = round.records.find((record) => record.reviewer === item.reviewer)?.issues.find((issue) => issue.id === item.issueId)
    return issue?.severity === 'blocker' || issue?.severity === 'major'
  }))
}
