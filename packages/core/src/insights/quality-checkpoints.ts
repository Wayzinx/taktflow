import type { CheckpointRef, Observation } from '../quality.js'
import type { EventEnvelope } from '../types.js'
import { comparePoints, eventPoint, eventsOf, type QualityData } from './quality-data.js'

export interface CheckpointEvidence {
  checkpoint: CheckpointRef
  scheduled?: EventEnvelope<'checkpoint.scheduled'>
  result?: EventEnvelope<'review.result'>
  completed?: EventEnvelope<'review.result' | 'gate.result'>
  point: ReturnType<typeof eventPoint>
}

export function checkpoints(data: QualityData): CheckpointEvidence[] {
  const entries = new Map<string, CheckpointEvidence>()
  for (const scheduled of eventsOf(data.events, 'checkpoint.scheduled')) entries.set(scheduled.data.checkpointId,
    { checkpoint: { ...scheduled.data }, scheduled, point: eventPoint(scheduled) })
  for (const result of eventsOf(data.events, 'review.result')) {
    const call = result.data.invocationId ? data.invocations.get(result.data.invocationId) : undefined
    let entry = entries.get(result.data.checkpointId)
    if (!entry) {
      entry = { checkpoint: { checkpointId: result.data.checkpointId, runId: result.runId, nodeId: result.nodeId ?? call?.invocation.nodeId ?? 'unknown',
        attempt: call?.invocation.attempt ?? 0, round: result.data.record.round, reviewer: result.data.record.reviewer, status: 'completed',
        materials: [...result.data.record.artifacts.map((ref) => ({ ref, sha256: '', role: 'target' as const })),
          ...result.data.references.map((ref) => ({ ref, sha256: '', role: 'reference' as const }))] }, point: eventPoint(call?.event ?? result) }
      entries.set(result.data.checkpointId, entry)
    }
    entry.result = result
    entry.completed = result
    entry.checkpoint = { ...entry.checkpoint, invocationId: result.data.invocationId, status: 'completed' }
  }
  for (const entry of entries.values()) {
    const call = entry.checkpoint.invocationId ? data.invocations.get(entry.checkpoint.invocationId) : undefined
    if (call?.invocation.outcome && call.invocation.outcome.status !== 'ok') entry.checkpoint.status = 'error'
    if (!entry.result) {
      const attempts = [...data.invocations.values()].filter((item) => item.invocation.checkpointId === entry.checkpoint.checkpointId)
      const last = attempts.at(-1)
      if (last) entry.checkpoint.invocationId = last.invocation.invocationId
      if (last?.invocation.outcome && last.invocation.outcome.status !== 'ok') entry.checkpoint.status = 'error'
      if (last?.invocation.outcome?.status === 'ok' && entry.checkpoint.checkId) {
        const next = [...entries.values()].find((item) => item.checkpoint.runId === entry.checkpoint.runId
          && item.checkpoint.nodeId === entry.checkpoint.nodeId && item.checkpoint.checkId === entry.checkpoint.checkId
          && comparePoints(item.point, entry.point) > 0)
        const result = eventsOf(data.events, 'gate.result').find((event) => event.runId === entry.checkpoint.runId
          && event.nodeId === entry.checkpoint.nodeId && comparePoints(eventPoint(event), eventPoint(last.event)) > 0
          && (!next || comparePoints(eventPoint(event), next.point) < 0) && event.data.checks.some((check) => check.id === entry.checkpoint.checkId))
        if (result) { entry.completed = result; entry.checkpoint.status = 'completed' }
      }
    }
  }
  return [...entries.values()].sort((a, b) => comparePoints(a.point, b.point))
}

function inScope(data: QualityData, observation: Observation, entry: CheckpointEvidence): boolean {
  if (observation.checkpointId === entry.checkpoint.checkpointId) return true
  const origin = eventsOf(data.events, 'checkpoint.scheduled').find((event) => event.data.checkpointId === observation.checkpointId)?.data
  const call = observation.invocationId ? data.invocations.get(observation.invocationId)?.invocation : undefined
  const reviewer = origin?.reviewer ?? call?.review?.reviewer
  return (origin?.runId ?? observation.runId ?? call?.runId) === entry.checkpoint.runId
    && (origin?.nodeId ?? observation.nodeId ?? call?.nodeId) === entry.checkpoint.nodeId
    && (origin?.attempt ?? observation.attempt ?? call?.attempt) === entry.checkpoint.attempt
    && reviewer !== undefined && reviewer === entry.checkpoint.reviewer
}

export function raisedEvidence(data: QualityData, entry: CheckpointEvidence, linked: Observation[], observations: Observation[]) {
  const scoped = linked.filter((item) => inScope(data, item, entry))
  const keys = new Set(scoped.flatMap((item) => item.issueKey ? [item.issueKey] : []))
  const issues = entry.result?.data.record.issues.filter((issue) => issue.key && keys.has(issue.key)) ?? []
  const previous = entry.result?.data.record.previous?.filter((item) => keys.has(item.key) && item.status === 'still_open') ?? []
  const direct = scoped.filter((item) => item.checkpointId === entry.checkpoint.checkpointId && (item.kind === 'found' || item.kind === 'still_open'))
  const raised = issues.length > 0 || previous.length > 0 || direct.length > 0
  const linkedIds = new Set(linked.map((item) => item.id))
  const overrides = observations.filter((item) => (item.kind === 'declined' || item.kind === 'overridden')
    && inScope(data, item, entry) && ((item.issueKey !== undefined && keys.has(item.issueKey)) || linkedIds.has(item.id))
    && comparePoints(data.observationPoint(item), entry.result ? eventPoint(entry.result) : entry.point) >= 0)
  return { raised, overrides, evidence: [...issues.map((issue) => `review.result issue ${issue.key}`),
    ...previous.map((item) => `review.result previous ${item.key}: still_open`), ...direct.map((item) => item.id), ...overrides.map((item) => item.id)] }
}
