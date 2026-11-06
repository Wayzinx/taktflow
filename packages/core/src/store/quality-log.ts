import { randomUUID } from 'node:crypto'
import { mkdir, open } from 'node:fs/promises'
import path from 'node:path'
import type { QualityEventType } from '../quality.js'
import { readFileIfExists } from './fs-utils.js'
import { chainHash, readAnchor, SHA256, writeAnchor, ZERO_HASH } from './hash-chain.js'
import type { QualityEventEnvelope, QualityEventInput, QualityVerifyResult } from './quality-store.js'

const TYPES = {
  'observation.recorded': true, 'defect.created': true, 'defect.updated': true, 'attribution.recorded': true,
  'evalcase.added': true, 'evalcase.updated': true, 'candidate.created': true, 'eval.started': true,
  'eval.sample': true, 'eval.finished': true, 'cursor.advanced': true, 'log.recovered': true,
} satisfies Record<QualityEventType, true>

function record(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value) }

export function validQualityInput(value: unknown): value is QualityEventInput {
  if (!record(value) || !record(value.actor) || !record(value.data) || typeof value.type !== 'string' || !Object.hasOwn(TYPES, value.type)) return false
  const actor = value.actor
  if (actor.type === 'human') return typeof actor.id === 'string' && typeof actor.via === 'string' && actor.via.length > 0
  if (actor.type === 'system') return typeof actor.id === 'string'
  return actor.type === 'agent' && typeof actor.role === 'string' && typeof actor.harness === 'string'
}

function payload(envelope: QualityEventEnvelope): unknown {
  const { hash: _hash, prevHash: _prev, ...data } = envelope
  return data
}

export function makeQualityEvents(inputs: Array<{ event: QualityEventInput; key: string }>, tail?: QualityEventEnvelope): QualityEventEnvelope[] {
  const commitId = randomUUID()
  const ts = new Date().toISOString()
  let seq = tail?.seq ?? 0
  let prevHash = tail?.hash ?? ZERO_HASH
  return inputs.map(({ event, key }, commitIndex) => {
    const envelope: QualityEventEnvelope = { ...event, seq: ++seq, ts, idempotencyKey: key,
      commitId, commitIndex, commitSize: inputs.length, prevHash, hash: '' }
    envelope.hash = chainHash(prevHash, payload(envelope))
    prevHash = envelope.hash
    return envelope
  })
}

export interface QualityLogState { events: QualityEventEnvelope[]; verification: QualityVerifyResult }

/** 调用方必须持有 log.jsonl 的文件锁。 */
export async function inspectQualityLog(file: string, anchorFile: string): Promise<QualityLogState> {
  const events: QualityEventEnvelope[] = []
  const bad = (reason: QualityVerifyResult['reason'], brokenAt: number): QualityLogState => ({ events, verification: { ok: false, reason, brokenAt } })
  let anchor
  try { anchor = await readAnchor(anchorFile) } catch { return bad('tampered', 0) }
  const bytes = await readFileIfExists(file)
  if (bytes === undefined) return anchor ? bad('missing', 0) : { events, verification: { ok: true } }
  const lines = bytes.toString('utf8').split('\n')
  if (lines.pop() !== '') return bad('truncated', lines.length + 1)
  const keys = new Set<string>()
  const commits = new Set<string>()
  for (const [index, line] of lines.entries()) {
    const seq = index + 1
    let value: unknown
    try { value = JSON.parse(line) } catch { return bad('tampered', seq) }
    if (!validQualityInput(value)) return bad('tampered', seq)
    const event = value as QualityEventEnvelope
    const last = events.at(-1)
    if (event.seq !== seq || typeof event.ts !== 'string' || !Number.isFinite(Date.parse(event.ts))
      || typeof event.idempotencyKey !== 'string' || !event.idempotencyKey || keys.has(event.idempotencyKey)
      || typeof event.commitId !== 'string' || !event.commitId
      || !Number.isSafeInteger(event.commitSize) || event.commitSize < 1
      || !Number.isSafeInteger(event.commitIndex) || event.commitIndex < 0 || event.commitIndex >= event.commitSize
      || typeof event.hash !== 'string' || !SHA256.test(event.hash)
      || event.prevHash !== (last?.hash ?? ZERO_HASH) || event.hash !== chainHash(event.prevHash, payload(event))) return bad('tampered', seq)
    if (last && last.commitIndex + 1 < last.commitSize) {
      if (event.commitId !== last.commitId || event.commitIndex !== last.commitIndex + 1 || event.commitSize !== last.commitSize) return bad('truncated', seq)
    } else {
      if (event.commitIndex !== 0 || commits.has(event.commitId)) return bad('tampered', seq)
      commits.add(event.commitId)
    }
    keys.add(event.idempotencyKey)
    events.push(event)
  }
  const last = events.at(-1)
  if (last && last.commitIndex + 1 !== last.commitSize) return bad('truncated', last.seq + 1)
  if (!anchor) return last ? bad('incomplete', 1) : { events, verification: { ok: true } }
  if ((last?.seq ?? 0) < anchor.lastSeq) return bad('truncated', (last?.seq ?? 0) + 1)
  const anchored = events[anchor.lastSeq - 1]!
  if (anchored.hash !== anchor.lastHash || anchored.commitIndex + 1 !== anchored.commitSize) return bad('tampered', anchor.lastSeq)
  if (last!.seq > anchor.lastSeq) return bad('incomplete', anchor.lastSeq + 1)
  return { events, verification: { ok: true } }
}

export async function writeQualityEvents(file: string, anchorFile: string, events: QualityEventEnvelope[]): Promise<void> {
  if (!events.length) return
  await mkdir(path.dirname(file), { recursive: true })
  const handle = await open(file, 'a')
  try {
    await handle.appendFile(events.map((event) => JSON.stringify(event)).join('\n') + '\n')
    await handle.sync()
  } finally { await handle.close() }
  await writeAnchor(anchorFile, events.at(-1)!)
}
