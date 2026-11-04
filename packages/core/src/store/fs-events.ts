import { statSync } from 'node:fs'
import { open, stat } from 'node:fs/promises'
import { StringDecoder } from 'node:string_decoder'
import type { EventStore } from '../interfaces.js'
import type { EventEnvelope, EventPayloads, EventType } from '../types.js'
import { canonicalJson, sha256 } from '../util/hash.js'
import { appendLine, isEnoent, readFileIfExists } from './fs-utils.js'
import { withLock } from './locks.js'
import { eventsFile } from './paths.js'

const ZERO_HASH = '0'.repeat(64)
const POLL_INTERVAL_MS = 300
const EVENT_TYPES = new Set<EventType>([
  'run.started', 'run.finished', 'node.ready', 'node.started', 'node.finished', 'node.failed', 'node.stale',
  'artifact.written', 'artifact.edited', 'artifact.untracked', 'gate.result', 'judge.verdict',
  'human.requested', 'human.answered', 'harness.started', 'harness.message', 'harness.tool_call',
  'harness.usage', 'context.assembled', 'context.compacted', 'knowledge.query', 'dag.expanded',
  'guard.violation', 'log',
])

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

export class FsEventStore implements EventStore {
  constructor(private readonly taktDir: string) {}

  async append<T extends EventType>(
    runId: string,
    e: { type: T; actor: EventEnvelope['actor']; nodeId?: string; data: EventPayloads[T] },
  ): Promise<EventEnvelope<T>> {
    const file = eventsFile(this.taktDir, runId)
    return withLock(file, async () => {
      const events = await this.readEvents(runId)
      const last = events.at(-1)
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
      envelope.hash = sha256(envelope.prevHash + canonicalJson(hashPayload(envelope)))
      await appendLine(file, JSON.stringify(envelope))
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
    const file = eventsFile(this.taktDir, runId)
    let decoder = new StringDecoder('utf8')
    // 同步取当前字节偏移：订阅只关心之后追加的事件，不能漏掉 subscribe 返回后立刻写入的那条
    let offset = 0
    try {
      offset = statSync(file).size
    } catch (err) {
      if (!isEnoent(err)) throw err
    }
    let pending = ''
    let reading = false
    let closed = false

    const poll = async (): Promise<void> => {
      if (closed || reading) return
      reading = true
      try {
        let size: number
        try {
          size = (await stat(file)).size
        } catch (err) {
          if (isEnoent(err)) return
          throw err
        }
        if (size < offset) {
          // 文件被替换或截断：从头重新跟上
          offset = 0
          pending = ''
          decoder = new StringDecoder('utf8')
        }
        if (size === offset) return
        const handle = await open(file, 'r')
        try {
          const buf = Buffer.alloc(size - offset)
          const { bytesRead } = await handle.read(buf, 0, buf.length, offset)
          offset += bytesRead
          pending += decoder.write(buf.subarray(0, bytesRead))
        } finally {
          await handle.close()
        }
        let idx: number
        while (!closed && (idx = pending.indexOf('\n')) >= 0) {
          const line = pending.slice(0, idx)
          pending = pending.slice(idx + 1)
          if (line.trim() === '') continue
          try {
            onEvent(JSON.parse(line) as EventEnvelope)
          } catch {
            // 坏行交给 verify 报告；订阅不能因为一条坏行停掉
          }
        }
      } catch {
        // 文件暂时不可读（例如正在被替换）时下个 tick 重试
      } finally {
        reading = false
      }
    }

    const timer = setInterval(() => {
      void poll()
    }, POLL_INTERVAL_MS)
    timer.unref()
    return () => {
      closed = true
      clearInterval(timer)
    }
  }

  /** 校验哈希链；返回第一处断链的 seq（损坏行按它应有的 seq 报）。 */
  async verify(runId: string): Promise<{ ok: boolean; brokenAt?: number }> {
    const buf = await readFileIfExists(eventsFile(this.taktDir, runId))
    if (buf === undefined) return { ok: true }
    let prevHash = ZERO_HASH
    let seq = 0
    for (const line of buf.toString('utf8').split('\n')) {
      if (line.trim() === '') continue
      seq += 1
      let envelope: unknown
      try {
        envelope = JSON.parse(line)
      } catch {
        return { ok: false, brokenAt: seq }
      }
      if (!isEnvelope(envelope, runId) || envelope.seq !== seq || envelope.prevHash !== prevHash) {
        return { ok: false, brokenAt: seq }
      }
      const expected = sha256(prevHash + canonicalJson(hashPayload(envelope)))
      if (envelope.hash !== expected) return { ok: false, brokenAt: seq }
      prevHash = envelope.hash
    }
    return { ok: true }
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
