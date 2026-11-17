import type { ReviewContinuity, ReviewIssue, ReviewRound } from '../../types.js'
import { sha256 } from '../../util/hash.js'

export function identifyIssue(issue: ReviewIssue): ReviewIssue & { groupKey: string; fingerprint: string } {
  const location = (issue.location ?? '').toLowerCase().replace(/(?::\d+(?::\d+)?(?:-\d+)?|#l\d+(?:-l?\d+)?)/g, '')
  const title = (issue.title ?? issue.description.slice(0, 40)).toLowerCase().replace(/[\p{P}\p{S}\s]/gu, '')
  return { ...issue, groupKey: `${location}:${issue.category ?? issue.severity}:${title}`,
    fingerprint: sha256(`${issue.location ?? ''}${issue.severity}${issue.description}`).slice(0, 16) }
}

function continuityIssue(issue: ReviewIssue): ReviewIssue & { groupKey: string; fingerprint: string } {
  const identified = identifyIssue(issue)
  return { ...identified, groupKey: issue.groupKey ?? identified.groupKey }
}

export function reviewContinuity(round: ReviewRound, prior?: ReviewRound): ReviewContinuity[] {
  const previous = (prior?.records ?? []).flatMap((record) => record.issues.map((issue) => {
    const identified = continuityIssue(issue)
    return { issue: identified, reviewer: record.reviewer }
  }))
  const byKey = new Map(previous.filter(item => item.issue.key).map(item => [item.issue.key!, item]))
  const byGroup = new Map(previous.map(item => [item.issue.groupKey, item]))
  const observed = new Set<string>()
  const result: ReviewContinuity[] = []
  for (const record of round.records) {
    record.issues = record.issues.map(continuityIssue)
    for (const issue of record.issues) {
      const before = (issue.key && byKey.get(issue.key)) || byGroup.get(issue.groupKey!)
      const response = before && prior?.responses.find(response => response.reviewer === before.reviewer && response.issueId === before.issue.id)
      // 作者已说明无法修复时，评审者改写同一问题不代表修复有进展。
      const cannotFix = response?.action === 'deferred' || response?.action === 'declined'
      const observation = !before ? 'new' : (cannotFix || before.issue.fingerprint === issue.fingerprint) ? 'repeated' : 'changed'
      const fixed = response?.action === 'fixed'
      result.push({ groupKey: issue.key ?? issue.groupKey!, issueId: issue.id, reviewer: record.reviewer,
        prevIssueId: before?.issue.id, observation, ...(observation === 'repeated' && fixed ? { regressed: true } : {}) })
      if (before) observed.add(before.issue.key ?? before.issue.groupKey)
    }
  }
  for (const before of previous) {
    const groupKey = before.issue.key ?? before.issue.groupKey
    if (observed.has(groupKey)) continue
    result.push({ groupKey, prevIssueId: before.issue.id, reviewer: before.reviewer, observation: 'not_observed' })
  }
  return result
}

export function noReviewProgress(rounds: ReviewRound[], limit = 2): boolean {
  if (limit === 0 || rounds.length < limit) return false
  return rounds.slice(-limit).every((round, index) => !round.passed && !(round.continuity ?? []).some((item) => {
    const prior = rounds[rounds.length - limit + index - 1]
    const issue = round.records.find(record => record.reviewer === item.reviewer)?.issues.find(issue => issue.id === item.issueId)
    if (item.observation === 'new') {
      return issue?.severity === 'blocker' || issue?.severity === 'major'
    }
    const before = prior?.records.flatMap(record => record.issues).find(previous =>
      (issue?.key && previous.key === issue.key) || continuityIssue(previous).groupKey === (issue?.groupKey ?? item.groupKey))
    if (issue && (issue.severity === 'blocker' || issue.severity === 'major')) {
      if (before && before.severity !== 'blocker' && before.severity !== 'major') return true
    }
    if (item.observation !== 'not_observed') return false
    const previous = prior?.records.find(record => record.reviewer === item.reviewer)?.issues.find(issue => issue.id === item.prevIssueId)
    return (previous?.severity === 'blocker' || previous?.severity === 'major') && prior?.responses.some(response =>
      response.reviewer === item.reviewer && response.issueId === item.prevIssueId && response.action === 'fixed')
  }))
}
