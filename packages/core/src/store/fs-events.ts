import { type Stats } from 'node:fs'
import path from 'node:path'
import { open, stat } from 'node:fs/promises'
import { subscribeJsonLines } from './jsonl-tail.js'
import type { EventStore } from '../interfaces.js'
import type { EventEnvelope, EventPayloads, EventType } from '../types.js'
import { chainHash, verifyChain, ZERO_HASH } from '../quality/chain.js'
import { appendLine, isEnoent, readFileIfExists } from './fs-utils.js'
import { withFileLock } from './file-lock.js'
import { eventsFile } from './paths.js'

// 用 Record 穷举：协议里新增事件类型而这里漏写时编译报错，不会在回读时才发现
const EVENT_TYPE_TABLE: Record<EventType, true> = {
  'run.started': true, 'run.finished': true, 'node.ready': true, 'node.started': true, 'node.finished': true, 'node.failed': true, 'node.stale': true,
  'artifact.written': true, 'artifact.edited': true, 'artifact.untracked': true, 'gate.result': true, 'judge.verdict': true,
  'human.requested': true, 'human.answered': true, 'harness.started': true, 'harness.message': true, 'harness.tool_call': true,
  'harness.usage': true, 'context.assembled': true, 'context.compacted': true, 'knowledge.query': true, 'dag.expanded': true,
  'guard.violation': true, log: true, 'review.round': true, 'review.response': true, 'review.exhausted': true,
  'review.arbitrated': true, 'review.disposition': true, 'rework.started': true, 'worktree.created': true, 'worktree.bootstrapped': true,
  'task.dispatched': true, 'node.checks': true, 'retry.suppressed': true, 'budget.warning': true, 'budget.exhausted': true,
  'route.decided': true, 'node.recipe': true, 'lesson.recalled': true, 'lesson.learned': true, 'lesson.updated': true, 'knowledge.used': true,
  'human.reminded': true, 'human.handed_back': true, 'checkpoint.scheduled': true, 'checkpoint.finished': true, 'snapshot.created': true,
  'invocation.started': true, 'invocation.finished': true, 'review.result': true, 'review.issue': true, 'node.rewound': true,
}
const EVENT_TYPES = new Set(Object.keys(EVENT_TYPE_TABLE))

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isEnvelope(value: unknown, runId: string): value is EventEnvelope {
  if (!isRecord(value) || !isRecord(value.actor) || !isRecord(value.data)) return false
  const actor = value.actor
  const validActor = actor.type === 'agent'
    ? typeof actor.role === 'string' && typeof actor.harness === 'string'
      && (actor.model === undefined || typeof actor.model === 'string')
    : (actor.type === 'human' || actor.type === 'system') && typeof actor.id === 'string'
  return validActor && Number.isSafeInteger(value.seq) && (value.seq as number) > 0
    && typeof value.ts === 'string' && Number.isFinite(Date.parse(value.ts))
    && value.runId === runId && (value.nodeId === undefined || typeof value.nodeId === 'string')
    && EVENT_TYPES.has(value.type as EventType)
    && typeof value.hash === 'string' && /^[a-f0-9]{64}$/.test(value.hash)
    && typeof value.prevHash === 'string' && /^[a-f0-9]{64}$/.test(value.prevHash)
}

/** 参与哈希的字段；nodeId 省略时不能凭空补 undefined，保证 append 和 verify 一致。 */
function hashPayload(envelope: EventEnvelope): Record<string, unknown> {
  return {
    seq: envelope.seq,
    ts: envelope.ts,
    runId: envelope.runId,
    ...(envelope.nodeId !== undefined ? { nodeId: envelope.nodeId } : {}),
    type: envelope.type,
    actor: envelope.actor,
    data: envelope.data,
  }
}

function verifyContent(buf: Buffer, runId: string): { ok: boolean; brokenAt?: number } {
  // 旧事件日志允许空行、无末尾换行和额外信封字段，保持既有 verify 语义。
  const { brokenAt } = verifyChain(buf.toString('utf8'), (value): value is EventEnvelope => isEnvelope(value, runId), {
    payload: hashPayload, ignoreBlankLines: true, requireFinalNewline: false,
  })
  return brokenAt === undefined ? { ok: true } : { ok: false, brokenAt }
}

interface AppendTail { size: number; ino: number; mtimeMs: number; ctimeMs: number; seq: number; hash: string; start: number }
const appendTails = new Map<string, AppendTail>()

function checkedLine(line: string, runId: string): EventEnvelope {
  let value: unknown
  try { value = JSON.parse(line) } catch { throw new Error(`事件日志尾部不是合法 JSON：${runId}`) }
  if (!isEnvelope(value, runId) || value.hash !== chainHash(value, hashPayload(value))
    || (value.seq === 1 && value.prevHash !== ZERO_HASH)) throw new Error(`事件日志尾部哈希或结构损坏：${runId}`)
  return value
}

async function appendTail(file: string, runId: string): Promise<AppendTail> {
  let info: Stats
  try { info = await stat(file) } catch (error) {
    if (!isEnoent(error)) throw error
    appendTails.delete(file)
    return { size: 0, ino: 0, mtimeMs: 0, ctimeMs: 0, seq: 0, hash: ZERO_HASH, start: 0 }
  }
  const cached = appendTails.get(file)
  if (cached && cached.ino === info.ino && cached.size === info.size && cached.mtimeMs === info.mtimeMs && cached.ctimeMs === info.ctimeMs) return cached
  const base = { size: info.size, ino: info.ino, mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs }
  if (info.size === 0) return { ...base, seq: 0, hash: ZERO_HASH, start: 0 }
  const handle = await open(file, 'r')
  try {
    const continuing = cached && cached.ino === info.ino && info.size > cached.size && cached.size > 0
    let offset = continuing ? cached.start : info.size
    let bytes = Buffer.alloc(0)
    if (continuing) {
      bytes = Buffer.alloc(info.size - offset)
      const result = await handle.read(bytes, 0, bytes.length, offset)
      if (result.bytesRead !== bytes.length) throw new Error(`读取事件日志时文件被截断：${runId}`)
    } else {
      // 冷缓存或文件替换仅扫描最后一行；完整审计仍由 verify 从头计算。
      while (offset > 0) {
        const length = Math.min(4096, offset)
        offset -= length
        const chunk = Buffer.alloc(length)
        const result = await handle.read(chunk, 0, length, offset)
        if (result.bytesRead !== length) throw new Error(`读取事件日志时文件被截断：${runId}`)
        bytes = Buffer.concat([chunk, bytes])
        const previous = bytes.lastIndexOf(10, bytes.length - 2)
        if (previous >= 0) { offset += previous + 1; bytes = bytes.subarray(previous + 1); break }
      }
    }
    if (bytes.at(-1) !== 10) throw new Error(`事件日志尾部未完整换行：${runId}`)
    const lines = bytes.toString('utf8').slice(0, -1).split('\n')
    let last: EventEnvelope | undefined
    let start = offset
    for (const [index, line] of lines.entries()) {
      let next: EventEnvelope
      try {
        next = checkedLine(line, runId)
        if (index === 0 && continuing && (next.seq !== cached.seq || next.hash !== cached.hash)) throw new Error('缓存边界已改变')
      } catch (error) {
        if (index !== 0 || !continuing) throw error
        const full = await readFileIfExists(file)
        if (!full || !verifyContent(full, runId).ok) throw new Error(`事件日志替换后断链：${runId}`, { cause: error })
        appendTails.delete(file)
        return appendTail(file, runId)
      }
      if (last && (next.seq !== last.seq + 1 || next.prevHash !== last.hash)) throw new Error(`事件日志尾部断链：${runId}`)
      last = next
      start = offset
      offset += Buffer.byteLength(line) + 1
    }
    return { ...base, seq: last!.seq, hash: last!.hash, start }
  } finally { await handle.close() }
}

export class FsEventStore implements EventStore {
  constructor(private readonly taktDir: string) {}

  async append<T extends EventType>(
    runId: string,
    e: { type: T; actor: EventEnvelope['actor']; nodeId?: string; data: EventPayloads[T] },
  ): Promise<EventEnvelope<T>> {
    const file = path.resolve(eventsFile(this.taktDir, runId))
    return withFileLock(file, async () => {
      const last = await appendTail(file, runId)
      const envelope: EventEnvelope<T> = {
        seq: (last?.seq ?? 0) + 1,
        ts: new Date().toISOString(),
        runId,
        type: e.type,
        actor: e.actor,
        data: e.data,
        prevHash: last?.hash ?? ZERO_HASH,
        hash: '',
      }
      if (e.nodeId !== undefined) envelope.nodeId = e.nodeId
      envelope.hash = chainHash(envelope, hashPayload(envelope))
      await appendLine(file, JSON.stringify(envelope))
      const info = await stat(file)
      appendTails.set(file, { size: info.size, ino: info.ino, mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs, seq: envelope.seq, hash: envelope.hash, start: last.size })
      return envelope
    })
  }

  async read(
    runId: string,
    opts?: { afterSeq?: number; nodeId?: string; types?: EventType[] },
  ): Promise<EventEnvelope[]> {
    let events = await this.readEvents(runId)
    const afterSeq = opts?.afterSeq
    if (afterSeq !== undefined) events = events.filter((e) => e.seq > afterSeq)
    const nodeId = opts?.nodeId
    if (nodeId !== undefined) events = events.filter((e) => e.nodeId === nodeId)
    const types = opts?.types
    if (types !== undefined && types.length > 0) {
      const wanted = new Set(types)
      events = events.filter((e) => wanted.has(e.type))
    }
    return events
  }

  subscribe(runId: string, onEvent: (e: EventEnvelope) => void): () => void {
    return subscribeJsonLines(eventsFile(this.taktDir, runId), onEvent)
  }

  /** 校验哈希链；返回第一处断链的 seq（损坏行按它应有的 seq 报）。 */
  async verify(runId: string): Promise<{ ok: boolean; brokenAt?: number }> {
    const buf = await readFileIfExists(eventsFile(this.taktDir, runId))
    if (buf === undefined) return { ok: true }
    return verifyContent(buf, runId)
  }

  private async readEvents(runId: string): Promise<EventEnvelope[]> {
    const buf = await readFileIfExists(eventsFile(this.taktDir, runId))
    if (buf === undefined) return []
    const lines = buf.toString('utf8').split('\n')
    const events: EventEnvelope[] = []
    for (const [i, line] of lines.entries()) {
      if (line.trim() === '') continue
      try {
        const envelope: unknown = JSON.parse(line)
        if (!isEnvelope(envelope, runId)) throw new Error('事件信封结构或 runId 不合法')
        events.push(envelope)
      } catch (err) {
        throw new Error(`事件日志第 ${i + 1} 行不是合法事件：${eventsFile(this.taktDir, runId)}`, { cause: err })
      }
    }
    return events
  }
}
