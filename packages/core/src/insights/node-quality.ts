import type { CheckpointDetail } from '../api.js'
import type { ProjectStores } from '../interfaces.js'
import type { Checkpoint, EventPayloads, Invocation, InvocationEnd, InvocationStart, ReviewIssueEntry, SnapshotManifest } from '../types.js'
import { replayIssues } from '../engine/issues.js'
import { mergeInvocation } from '../engine/invocations.js'
import { assertNodeId, assertRunId } from '../store/paths.js'

export async function nodeQuality(stores: ProjectStores, runId: string, nodeId: string): Promise<{ checkpoints: CheckpointDetail[]; invocations: Invocation[]; issues?: ReviewIssueEntry[] }> {
  assertRunId(runId); assertNodeId(nodeId)
  const events = await stores.events.read(runId, { nodeId })
  const checkpoints = new Map<string, CheckpointDetail>()
  const invocations = new Map<string, Invocation>()
  for (const event of events) {
    if (event.type === 'checkpoint.scheduled') {
      const point = event.data as Checkpoint
      checkpoints.set(point.id, { ...point, status: 'scheduled', invocations: [] })
    } else if (event.type === 'checkpoint.finished') {
      const data = event.data as EventPayloads['checkpoint.finished']
      const point = checkpoints.get(data.id)
      if (point) Object.assign(point, { status: data.status, error: data.error, endedAt: event.ts })
    } else if (event.type === 'snapshot.created') {
      const data = event.data as SnapshotManifest
      const point = checkpoints.get(data.checkpointId)
      if (point) point.snapshot = data
    } else if (event.type === 'invocation.started') {
      const data = event.data as InvocationStart
      invocations.set(data.id, data)
      if (data.checkpointId) checkpoints.get(data.checkpointId)?.invocations.push(data.id)
    } else if (event.type === 'invocation.finished') {
      const data = event.data as InvocationEnd
      const start = invocations.get(data.id)
      if (start) invocations.set(data.id, mergeInvocation(start, data))
    } else if (event.type === 'review.result') {
      const data = event.data as EventPayloads['review.result']
      const point = checkpoints.get(data.checkpointId)
      if (point) point.record = data.record
    } else if (event.type === 'gate.result') {
      for (const check of (event.data as EventPayloads['gate.result']).checks) {
        const point = check.checkpointId ? checkpoints.get(check.checkpointId) : undefined
        if (point) point.gate = check
      }
    }
  }
  return { checkpoints: [...checkpoints.values()], invocations: [...invocations.values()], issues: replayIssues(events) }
}
