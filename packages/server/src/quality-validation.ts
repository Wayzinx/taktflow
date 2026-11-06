import type { Actor, ArtifactRef, AssetRef, AttributionView, Escape } from '@taktflow/core'
import { ApiError } from './errors.js'
import { artifactPath, safeId, text } from './validation.js'

export function object(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ApiError(400, `${name} 必须是对象`)
  return value as Record<string, unknown>
}

export function oneOf<const T extends string>(value: unknown, values: readonly T[], name: string): T {
  if (typeof value !== 'string' || !values.includes(value as T)) throw new ApiError(400, `${name} 必须是 ${values.join(' / ')}`)
  return value as T
}

export function positive(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) throw new ApiError(400, `${name} 必须是正整数`)
  return value
}

export function strings(value: unknown, name: string, nonempty = false): string[] {
  if (!Array.isArray(value) || (nonempty && !value.length)) throw new ApiError(400, `${name} 必须是${nonempty ? '非空' : ''}数组`)
  const items = value.map((item) => text(item, name))
  if (new Set(items).size !== items.length) throw new ApiError(400, `${name} 不能重复`)
  return items
}

export function array<T>(value: unknown, name: string, parse: (item: Record<string, unknown>) => T): T[] {
  if (!Array.isArray(value)) throw new ApiError(400, `${name} 必须是数组`)
  return value.map((item) => parse(object(item, name)))
}

export function human(actor: Actor): void {
  if (actor.type !== 'human') throw new ApiError(400, '此操作需要人确认')
  text(actor.id, 'actor.id')
  text(actor.via, 'actor.via')
}

export function qualityActor(actor: Actor): void {
  if (actor.type === 'human') human(actor)
  else if (actor.type === 'agent') { text(actor.role, 'actor.role'); text(actor.harness, 'actor.harness') }
  else if (actor.type === 'system') text(actor.id, 'actor.id')
  else throw new ApiError(400, 'actor 不合法')
}

export function hash(value: unknown, name: string): string {
  const result = text(value, name)
  if (!/^[a-f0-9]{64}$/.test(result)) throw new ApiError(400, `${name} 必须是 sha256`)
  return result
}

export function asset(value: unknown): AssetRef {
  const item = object(value, 'asset')
  return { kind: oneOf(item.kind, ['file', 'plugin', 'inline'], 'asset.kind'), id: text(item.id, 'asset.id'), sha256: hash(item.sha256, 'asset.sha256'),
    ...(item.revision === undefined ? {} : { revision: text(item.revision, 'asset.revision') }) }
}

export function artifact(value: unknown): ArtifactRef {
  const item = object(value, 'artifact')
  return { workspace: safeId(text(item.workspace, 'workspace')), path: artifactPath(item.path), version: positive(item.version, 'version') }
}

export function attribution(value: unknown, by: Actor): AttributionView {
  const item = object(value, 'attribution')
  if (item.method !== undefined && item.method !== 'human') throw new ApiError(400, '一期归因必须由人确认')
  const injected = item.injected === undefined ? undefined : object(item.injected, 'injected')
  if (injected?.human !== undefined && typeof injected.human !== 'boolean') throw new ApiError(400, 'injected.human 必须是布尔值')
  return {
    status: oneOf(item.status, ['candidate', 'confirmed', 'disputed', 'unknown'], 'attribution.status'),
    ...(item.category === undefined ? {} : { category: oneOf(item.category, ['requirement', 'design', 'test_design', 'code', 'automation', 'knowledge', 'environment', 'process'], 'category') }),
    ...(injected === undefined ? {} : { injected: {
      artifact: artifact(injected.artifact), diffEvidence: text(injected.diffEvidence, 'diffEvidence'),
      ...(injected.previous === undefined ? {} : { previous: artifact(injected.previous) }),
      ...(injected.invocationId === undefined ? {} : { invocationId: text(injected.invocationId, 'invocationId') }),
      ...(injected.human === undefined ? {} : { human: injected.human as boolean }),
    } }),
    escapes: array(item.escapes, 'escapes', (entry): Escape => ({
      checkpointId: text(entry.checkpointId, 'checkpointId'), runId: text(entry.runId, 'runId'), nodeId: text(entry.nodeId, 'nodeId'),
      attempt: positive(entry.attempt, 'attempt'), verdict: oneOf(entry.verdict, ['should_have_caught', 'caught_but_overridden', 'not_exposed', 'not_executed', 'out_of_scope', 'undetermined'], 'verdict'),
      rationale: text(entry.rationale, 'rationale'), evidence: strings(entry.evidence, 'evidence'),
      ...(entry.round === undefined ? {} : { round: positive(entry.round, 'round') }),
      ...Object.fromEntries(['invocationId', 'reviewer', 'checkId', 'humanRequestId'].filter((key) => entry[key] !== undefined).map((key) => [key, text(entry[key], key)])),
    })),
    candidates: array(item.candidates, 'candidates', (entry) => ({ artifact: artifact(entry.artifact), reason: text(entry.reason, 'reason'),
      ...(entry.invocationId === undefined ? {} : { invocationId: text(entry.invocationId, 'invocationId') }) })),
    method: 'human', rationale: text(item.rationale, 'rationale'), evidence: strings(item.evidence, 'evidence'), by, at: new Date().toISOString(),
  }
}
