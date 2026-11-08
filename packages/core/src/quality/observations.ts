import type { EventEnvelope, EventPayloads, Observation, ObservationKind } from '../types.js'

export function eventObservations(event: EventEnvelope, requirementId: string): Observation[] {
  const base = { requirementId, runId: event.runId, nodeId: event.nodeId, at: event.ts, by: event.actor,
    invocationId: event.actor.type === 'agent' ? event.actor.invocationId : undefined }
  const identity = (source: Observation['source'], index: number) => ({ ...base, source, id: `${source}:${event.runId}:${event.seq}:${index}` })
  if (event.type === 'review.issue') {
    const data = event.data as EventPayloads['review.issue']
    const kinds: Partial<Record<typeof data.action, ObservationKind>> = { raised: 'finding', reobserved: 'finding', still_open: 'finding', reopened: 'finding',
      claimed_fixed: 'claimed_fixed', verified_fixed: 'verified_fixed', dismissed: 'declined', waived: 'waived' }
    const kind = kinds[data.action]
    return kind ? [{ ...identity('review', 0), kind, subject: data.key, checkpointId: data.checkpointId,
      severity: data.entry.severity, title: data.entry.title, detail: data.note }] : []
  }
  if (event.type === 'judge.verdict') {
    const data = event.data as EventPayloads['judge.verdict']
    return data.verdicts.map((verdict, index) => ({ ...identity('judge', index), subject: verdict.subject,
      kind: data.routed.some((route) => route.subject === verdict.subject && route.to === 'ignore') ? 'ignored' : verdict.category === 'flaky' ? 'flaky' : 'failure',
      title: verdict.subject, detail: [verdict.rationale, ...verdict.evidence].join('\n') }))
  }
  if (event.type === 'gate.result') {
    const data = event.data as EventPayloads['gate.result']
    return data.checks.flatMap((check, index): Observation[] => {
      const status = check.status ?? (check.pass ? 'pass' : 'fail')
      return status === 'pass' ? [] : [{ ...identity('gate', index), subject: check.id, checkpointId: check.checkpointId,
        kind: status === 'error' ? 'gate_error' : 'gate_fail', title: check.id, detail: check.message }]
    })
  }
  return []
}
