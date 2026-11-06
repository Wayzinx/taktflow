import type { EventEnvelope, EventPayloads, QualityMetrics } from '../types.js'
import { readReviewRounds, type ReviewWorkspace } from './review-rounds.js'

export async function qualityMetrics(events: EventEnvelope[], workspace: ReviewWorkspace): Promise<QualityMetrics> {
  const result: QualityMetrics = { verified: 0, intercepted: 0, interceptedBy: { gate: 0, review: 0, judge: 0, completion: 0, fingerprint: 0 } }
  for (const event of events) {
    if (event.type === 'gate.result') {
      for (const check of (event.data as EventPayloads['gate.result']).checks) {
        if (check.pass) result.verified++
        else result.interceptedBy.gate++
      }
    } else if (event.type === 'review.round' && (event.data as EventPayloads['review.round']).passed) result.verified++
    else if (event.type === 'judge.verdict') result.interceptedBy.judge += (event.data as EventPayloads['judge.verdict']).verdicts.filter(verdict => verdict.category === 'product_bug').length
    else if (event.type === 'node.checks' && (event.data as EventPayloads['node.checks']).unmet.length) result.interceptedBy.completion++
    else if (event.type === 'retry.suppressed') result.interceptedBy.fingerprint++
  }
  for (const { round } of await readReviewRounds(workspace, new Set(events.map(event => event.runId)))) {
    if (!round.passed) result.interceptedBy.review += round.records.flatMap(record => record.issues)
      .filter(issue => issue.severity === 'blocker' || issue.severity === 'major').length
  }
  result.intercepted = Object.values(result.interceptedBy).reduce((a, b) => a + b, 0)
  return result
}
