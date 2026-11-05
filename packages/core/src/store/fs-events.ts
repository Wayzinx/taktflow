import { statSync, type Stats } from 'node:fs'
import path from 'node:path'
import { open, stat } from 'node:fs/promises'
import { StringDecoder } from 'node:string_decoder'
import type { EventStore, EventVerifyReason } from '../interfaces.js'
import type { EventEnvelope, EventPayloads, EventType } from '../types.js'
import { canonicalJson, sha256 } from '../util/hash.js'
import { appendLine, isEnoent, readFileIfExists, readJsonFile, toJsonText, writeFileAtomic } from './fs-utils.js'
import { withFileLock } from './file-lock.js'
import { chainFile, eventsFile } from './paths.js'

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

/** 链尾锚点：追加事件后原子写入，用于发现截尾和正常追加掩盖截尾。 */
interface ChainAnchor { lastSeq: number; lastHash: string; updatedAt: string }

async function readAnchor(file: string): Promise<ChainAnchor | undefined> {
  const value = await readJsonFile<unknown>(file)
  if (value === undefined) return undefined
  const anchor = value as Partial<ChainAnchor> | null
  if (anchor === null || typeof anchor !== 'object'
    || !Number.isSafeInteger(anchor.lastSeq) || (anchor.lastSeq as number) < 1
    || typeof anchor.lastHash !== 'string' || !/^[a-f0-9]{64}$/.test(anchor.lastHash)
    || typeof anchor.updatedAt !== 'string') {
    throw new Error(`链尾锚点损坏：${file}`)
  }
  return anchor as ChainAnchor
}

function lastEnvelope(buf: Buffer): EventEnvelope | undefined {
  const lines = buf.toString('utf8').split('\n').filter((line) => line.trim() !== '')
  const line = lines.at(-1)
  return line === undefined ? undefined : JSON.parse(line) as EventEnvelope
}

function verifyContent(buf: Buffer, runId: string): { ok: boolean; brokenAt?: number } {
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

interface AppendTail { size: number; ino: number; mtimeMs: number; ctimeMs: number; seq: number; hash: string; start: number }
const appendTails = new Map<string, AppendTail>()

function checkedLine(line: string, runId: string): EventEnvelope {
  let value: unknown
  try { value = JSON.parse(line) } catch { throw new Error(`事件日志尾部不是合法 JSON：${runId}`) }
  if (!isEnvelope(value, runId) || value.hash !== sha256(value.prevHash + canonicalJson(hashPayload(value)))
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
    const anchorFile = chainFile(this.taktDir, runId)
    return withFileLock(file, async () => {
      const last = await appendTail(file, runId)
      const anchor = await readAnchor(anchorFile)
      // 锁内先核对磁盘尾部和旧锚点：截尾后的正常追加不能把锚点覆盖掉。
      if (anchor && (last.seq !== anchor.lastSeq || last.hash !== anchor.lastHash)) {
        throw new Error(`事件日志与锚点不一致：${runId}`)
      }
      const envelope: EventEnvelope<T> = {
        seq: last.seq + 1,
        ts: new Date().toISOString(),
        runId,
        type: e.type,
        actor: e.actor,
        data: e.data,
        prevHash: last.hash,
        hash: '',
      }
      if (e.nodeId !== undefined) envelope.nodeId = e.nodeId
      envelope.hash = sha256(envelope.prevHash + canonicalJson(hashPayload(envelope)))
      await appendLine(file, JSON.stringify(envelope))
      const info = await stat(file)
      appendTails.set(file, { size: info.size, ino: info.ino, mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs, seq: envelope.seq, hash: envelope.hash, start: last.size })
      await writeFileAtomic(anchorFile, toJsonText({
        lastSeq: envelope.seq,
        lastHash: envelope.hash,
        updatedAt: new Date().toISOString(),
      }))
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

  /** 校验哈希链和链尾锚点；返回第一处断链的 seq（损坏行按它应有的 seq 报）。 */
  async verify(runId: string): Promise<{ ok: boolean; brokenAt?: number; reason?: EventVerifyReason }> {
    const file = path.resolve(eventsFile(this.taktDir, runId))
    const anchorFile = chainFile(this.taktDir, runId)
    // 与 append 共用跨进程锁，避免读到"事件已追加、锚点未更新"的中间态。
    return withFileLock(file, async () => {
      let anchor: ChainAnchor | undefined
      try {
        anchor = await readAnchor(anchorFile)
      } catch {
        return { ok: false, brokenAt: 0, reason: 'tampered' as const }
      }
      const buf = await readFileIfExists(file)
      if (anchor === undefined) {
        if (buf === undefined) return { ok: true }
        return verifyContent(buf, runId)
      }
      if (buf === undefined) return { ok: false, brokenAt: 0, reason: 'missing' as const }
      const chain = verifyContent(buf, runId)
      if (!chain.ok) return { ...chain, reason: 'tampered' as const }
      const last = lastEnvelope(buf)
      const lastSeq = last?.seq ?? 0
      if (lastSeq === anchor.lastSeq && last?.hash === anchor.lastHash) return { ok: true }
      // 恰好多一条且前缀 hash 对得上：追加后、写锚点前中断，不能自动修复成可信。
      if (lastSeq === anchor.lastSeq + 1 && last?.prevHash === anchor.lastHash) {
        return { ok: false, brokenAt: anchor.lastSeq + 1, reason: 'incomplete' as const }
      }
      if (lastSeq < anchor.lastSeq) return { ok: false, brokenAt: lastSeq + 1, reason: 'truncated' as const }
      if (lastSeq === anchor.lastSeq) return { ok: false, brokenAt: anchor.lastSeq, reason: 'tampered' as const }
      return { ok: false, brokenAt: anchor.lastSeq + 1, reason: 'tampered' as const }
    })
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
