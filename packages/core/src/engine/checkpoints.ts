import type { Checkpoint, CheckpointRole, SnapshotManifest } from '../types.js'
import type { HarnessHost } from './harness.js'

type Host = Pick<HarnessHost, 'state' | 'emit' | 'timestamp'>
export interface CaptureContext { role: CheckpointRole; checkpointId?: string; snapshot?: SnapshotManifest }
// Runtime.model 的协议不变；按 host + node 隔离，避免并发节点串用检查点。
const contexts = new WeakMap<object, Map<string, CaptureContext>>()
export function captureContext(host: object, nodeId: string): CaptureContext | undefined { return contexts.get(host)?.get(nodeId) }
export async function withCapture<T>(host: object, nodeId: string, context: CaptureContext, fn: () => Promise<T>): Promise<T> {
  let nodes = contexts.get(host)
  if (!nodes) { nodes = new Map(); contexts.set(host, nodes) }
  const previous = nodes.get(nodeId)
  nodes.set(nodeId, context)
  try { return await fn() } finally { if (previous) nodes.set(nodeId, previous); else nodes.delete(nodeId) }
}
export function checkpointId(runId: string, nodeId: string, attempt: number, revision: number, round: number, subject: string): string {
  return `${runId}:${nodeId}:${attempt}:${revision}.${round}:${subject}`
}
export async function scheduleCheckpoint(host: Host, nodeId: string, role: CheckpointRole, subject: string, duties: string[] = [], revision = 1, round = 1): Promise<Checkpoint> {
  const attempt = host.state.nodes[nodeId]!.attempts
  const point: Checkpoint = { id: checkpointId(host.state.runId, nodeId, attempt, revision, round, subject),
    runId: host.state.runId, nodeId, attempt, revision, round, role, subject, duties, scheduledAt: host.timestamp() }
  await host.emit('checkpoint.scheduled', point, nodeId)
  return point
}
export async function finishCheckpoint(host: Host, point: Checkpoint, status: 'done' | 'error' | 'skipped', error?: unknown): Promise<void> {
  await host.emit('checkpoint.finished', { id: point.id, status, ...(error === undefined ? {} : { error: error instanceof Error ? error.message : String(error) }) }, point.nodeId)
}
export function rubricDuties(text: string): string[] {
  return text.split(/\n+/).map(line => line.replace(/^\s*(?:[-*•]|\d+[.)、])\s*/, '').trim()).filter(Boolean)
}
