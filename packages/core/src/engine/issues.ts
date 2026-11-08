import type { EventEnvelope, EventPayloads, ReviewIssueEntry, ReviewRecord, ReviewResponse } from '../types.js'
import type { HarnessHost } from './harness.js'
import { identifyIssue } from './nodes/review-continuity.js'

type Host = Pick<HarnessHost, 'emit' | 'timestamp'>
type Action = ReviewIssueEntry['history'][number]['action']
export function replayIssues(events: EventEnvelope[]): ReviewIssueEntry[] {
  const entries = new Map<string, ReviewIssueEntry>()
  for (const event of events) {
    if (event.type !== 'review.issue') continue
    const data = event.data as EventPayloads['review.issue']
    const history = entries.get(data.key)?.history ?? []
    entries.set(data.key, { ...data.entry, history: [...history, { revision: data.revision, round: data.round, action: data.action, by: data.by, note: data.note, at: event.ts }] })
  }
  return [...entries.values()]
}
export async function issueAction(host: Host, nodeId: string, issue: ReviewIssueEntry, action: Action, by: string, revision: number, round: number, checkpointId?: string, note?: string): Promise<void> {
  const statuses: Partial<Record<Action, ReviewIssueEntry['status']>> = { claimed_fixed: 'claimed_fixed', verified_fixed: 'verified_fixed', still_open: 'open', reopened: 'open', reobserved: 'open', dismissed: 'dismissed', waived: 'waived' }
  issue.status = statuses[action] ?? issue.status
  issue.last = { revision, round, checkpointId }
  issue.history.push({ revision, round, action, by, note, at: host.timestamp() })
  const { history: _history, ...entry } = issue
  await host.emit('review.issue', { key: issue.key, action, revision, round, by, checkpointId, note, entry }, nodeId)
}
export async function recordIssues(host: Host, nodeId: string, ledger: ReviewIssueEntry[], record: ReviewRecord, revision: number): Promise<void> {
  const existing = new Map(ledger.map(issue => [issue.key, issue]))
  const observed = new Set<string>()
  let next = Math.max(0, ...ledger.map(issue => Number(issue.key.replace('ISS-', '')) || 0)) + 1
  for (let index = 0; index < record.issues.length; index++) {
    const issue = identifyIssue(record.issues[index]!)
    let entry = issue.key ? existing.get(issue.key) : undefined
    if (issue.key && !entry) await host.emit('log', { level: 'warn', message: `评审者 ${record.reviewer} 引用了未知问题键 ${issue.key}；按新问题分配系统键` }, nodeId)
    if (!entry) {
      issue.key = `ISS-${next++}`
      entry = { key: issue.key, title: issue.title ?? issue.description, severity: issue.severity, location: issue.location,
        status: 'open', raisedBy: record.reviewer, groupKey: issue.groupKey, duty: issue.duty,
        first: { revision, round: record.round, checkpointId: record.checkpointId }, last: { revision, round: record.round, checkpointId: record.checkpointId }, history: [] }
      ledger.push(entry)
      await issueAction(host, nodeId, entry, 'raised', record.reviewer, revision, record.round, record.checkpointId, issue.description)
    } else {
      entry.title = issue.title ?? issue.description; entry.severity = issue.severity; entry.location = issue.location
      await issueAction(host, nodeId, entry, entry.status === 'verified_fixed' ? 'reopened' : 'reobserved', record.reviewer, revision, record.round, record.checkpointId, issue.description)
    }
    issue.key = entry.key
    record.issues[index] = issue
    observed.add(entry.key)
  }
  for (const entry of existing.values()) {
    if (observed.has(entry.key) || entry.status === 'dismissed' || entry.status === 'waived') continue
    // 每个评审者只复查自己的清单；裁决者可显式复查任何既有问题。
    const previous = record.previous?.find(item => item.key === entry.key)
    if (!previous && entry.raisedBy !== record.reviewer) continue
    if (entry.status === 'verified_fixed' && !previous) continue
    await issueAction(host, nodeId, entry, previous?.status === 'resolved' ? 'verified_fixed' : previous?.status === 'still_open' ? 'still_open' : 'not_checked',
      record.reviewer, revision, record.round, record.checkpointId, previous?.note)
  }
}
export async function recordResponses(host: Host, nodeId: string, ledger: ReviewIssueEntry[], records: ReviewRecord[], responses: ReviewResponse[], revision: number, checkpointId?: string): Promise<void> {
  for (const response of responses) {
    response.key = records.find(record => record.reviewer === response.reviewer)?.issues.find(issue => issue.id === response.issueId)?.key
    const entry = ledger.find(issue => issue.key === response.key)
    if (entry && response.action === 'fixed' && entry.status !== 'waived' && entry.status !== 'dismissed') {
      await issueAction(host, nodeId, entry, 'claimed_fixed', 'author', revision, response.round, checkpointId, response.note)
    }
  }
}
export function issuePrompt(ledger: ReviewIssueEntry[]): string {
  return `系统问题台账（引用已有 key；新问题不填 key，禁止自造 ISS- 编号；对未关闭问题逐条填写 previous）：\n${JSON.stringify(ledger.filter(issue => issue.status === 'open' || issue.status === 'claimed_fixed').map(issue => ({ key: issue.key, title: issue.title, status: issue.status, authorResponse: issue.history.filter(item => item.action === 'claimed_fixed').at(-1)?.note })))}`
}
