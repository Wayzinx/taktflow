import { type Stats } from 'node:fs'
import path from 'node:path'
import { open, stat, type FileHandle } from 'node:fs/promises'
import { subscribeJsonLines } from './jsonl-tail.js'
import type { EventStore } from '../interfaces.js'
import type { EventEnvelope, EventPayloads, EventType } from '../types.js'
import { chainHash, ZERO_HASH } from '../quality/chain.js'
import { appendLine, isEnoent } from './fs-utils.js'
import { withFileLock } from './file-lock.js'
import { eventsFile } from './paths.js'

// 用 Record 穷举：协议里新增事件类型而这里漏写时编译报错，不会在回读时才发现
const EVENT_TYPE_TABLE: Record<EventType, true> = {
  'run.retried': true,
  'run.started': true, 'run.finished': true, 'node.ready': true, 'node.started': true, 'node.finished': true, 'node.failed': true, 'node.stale': true,
  'artifact.written': true, 'artifact.edited': true, 'artifact.untracked': true, 'gate.result': true, 'judge.verdict': true,
  'human.requested': true, 'human.answered': true, 'harness.started': true, 'harness.message': true, 'harness.tool_call': true,
  'harness.usage': true, 'context.assembled': true, 'context.compacted': true, 'knowledge.query': true, 'dag.expanded': true,
  'guard.violation': true, log: true, 'review.round': true, 'review.response': true, 'review.exhausted': true,
  'review.arbitrated': true, 'review.disposition': true, 'rework.started': true, 'worktree.created': true, 'worktree.bootstrapped': true,
  'task.dispatched': true, 'node.checks': true, 'retry.suppressed': true, 'budget.warning': true, 'budget.exhausted': true,
  'route.decided': true, 'node.recipe': true, 'lesson.recalled': true, 'lesson.learned': true, 'lesson.updated': true, 'output.invalid': true, 'output.repaired': true, 'knowledge.used': true,
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

interface FileStamp { size: number; ino: number; mtimeMs: number; ctimeMs: number }
interface AppendTail extends FileStamp { seq: number; hash: string; start: number }
interface Checkpoint { offset: number; seq: number; lines: number }
interface ReadTail extends FileStamp, Checkpoint { checkpoints: Checkpoint[] }
interface VerifyTail extends FileStamp { offset: number; seq: number; hash: string }
// 三种状态独立取文件签名：append 只在签名完全相同时复用；read（含检查点）和 verify
// 仅在同 inode 变长或签名未变时复用。任何一方都不能把另一方尚未处理的前缀标为已处理。
const fileTails = new Map<string, { append?: AppendTail; read?: ReadTail; verify?: VerifyTail }>()
function tails(file: string) {
  let value = fileTails.get(file)
  if (!value) { value = {}; fileTails.set(file, value) }
  return value
}

function fileStamp(info: Stats): FileStamp {
  return { size: info.size, ino: info.ino, mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs }
}

function reusable(cached: FileStamp, info: Stats): boolean {
  return cached.ino === info.ino && (info.size > cached.size || info.size === cached.size
    && info.mtimeMs === cached.mtimeMs && info.ctimeMs === cached.ctimeMs)
}

function currentTails(file: string, info: Stats) {
  const state = tails(file)
  // 任一路径发现替换、截断或等长改写都广播失效；否则 append 后的增长会掩盖刚发生的改写。
  if (Object.values(state).some(cached => !reusable(cached, info))) {
    fileTails.delete(file)
    return tails(file)
  }
  return state
}

// 按字节保留半行，UTF-8 只有到行边界才解码；返回 false 可在首个坏行立即停止。
async function scanLines(handle: FileHandle, size: number, offset: number, runId: string,
  visit: (line: string, end: number, complete: boolean) => boolean): Promise<void> {
  let position = offset, partial = Buffer.alloc(0)
  const chunk = Buffer.alloc(64 * 1024)
  while (position < size) {
    const { bytesRead } = await handle.read(chunk, 0, Math.min(chunk.length, size - position), position)
    if (!bytesRead) throw new Error(`读取事件日志时文件被截断：${runId}`)
    position += bytesRead
    const bytes = partial.length ? Buffer.concat([partial, chunk.subarray(0, bytesRead)]) : chunk.subarray(0, bytesRead)
    let start = 0
    for (let end = bytes.indexOf(10); end !== -1; end = bytes.indexOf(10, start)) {
      offset += end - start + 1
      if (!visit(bytes.subarray(start, end).toString('utf8'), offset, true)) return
      start = end + 1
    }
    partial = Buffer.from(bytes.subarray(start))
  }
  if (partial.length) visit(partial.toString('utf8'), size, false)
}

async function verifyFile(file: string, runId: string): Promise<{ ok: boolean; brokenAt?: number }> {
  let handle
  try { handle = await open(file, 'r') } catch (error) {
    if (!isEnoent(error)) throw error
    fileTails.delete(file)
    return { ok: true }
  }
  try {
    const info = await handle.stat(), state = currentTails(file, info)
    const prefix: VerifyTail = { ...fileStamp(info), offset: state.verify?.offset ?? 0,
      seq: state.verify?.seq ?? 0, hash: state.verify?.hash ?? ZERO_HASH }
    let brokenAt: number | undefined
    await scanLines(handle, info.size, prefix.offset, runId, (line, end, complete) => {
      if (line.trim()) {
        let value: unknown
        try { value = JSON.parse(line) } catch { brokenAt = prefix.seq + 1; return false }
        // 与 verifyChain 的旧事件选项等价：空行不计 seq，额外字段不参与哈希，半行也校验。
        if (!isEnvelope(value, runId) || value.seq !== prefix.seq + 1 || value.prevHash !== prefix.hash
          || value.hash !== chainHash(value, hashPayload(value))) { brokenAt = prefix.seq + 1; return false }
        if (complete) { prefix.seq = value.seq; prefix.hash = value.hash }
      }
      // 无末尾换行的有效信封也不能进入缓存，下次必须从这里重新校验。
      if (complete) prefix.offset = end
      return true
    })
    state.verify = prefix
    return brokenAt === undefined ? { ok: true } : { ok: false, brokenAt }
  } finally { await handle.close() }
}

function checkpointBefore(checkpoints: Checkpoint[], seq: number): Checkpoint | undefined {
  let low = 0, high = checkpoints.length
  while (low < high) {
    const mid = (low + high) >>> 1
    if (checkpoints[mid]!.seq <= seq) low = mid + 1
    else high = mid
  }
  return checkpoints[low - 1]
}

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
    fileTails.delete(file)
    return { size: 0, ino: 0, mtimeMs: 0, ctimeMs: 0, seq: 0, hash: ZERO_HASH, start: 0 }
  }
  const cached = currentTails(file, info).append
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
        delete tails(file).verify
        if (!(await verifyFile(file, runId)).ok) throw new Error(`事件日志替换后断链：${runId}`, { cause: error })
        fileTails.delete(file)
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
      tails(file).append = { size: info.size, ino: info.ino, mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs, seq: envelope.seq, hash: envelope.hash, start: last.size }
      return envelope
    })
  }

  async read(
    runId: string,
    opts?: { afterSeq?: number; nodeId?: string; types?: EventType[] },
  ): Promise<EventEnvelope[]> {
    let events = await this.readEvents(runId, opts?.afterSeq)
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
    return verifyFile(path.resolve(eventsFile(this.taktDir, runId)), runId)
  }

  private async readEvents(runId: string, afterSeq?: number): Promise<EventEnvelope[]> {
    const file = path.resolve(eventsFile(this.taktDir, runId))
    let handle
    try { handle = await open(file, 'r') } catch (error) {
      if (!isEnoent(error)) throw error
      fileTails.delete(file)
      return []
    }
    try {
      const info = await handle.stat()
      const state = currentTails(file, info)
      const cached = state.read
      const from = afterSeq === undefined || !cached ? undefined : afterSeq >= cached.seq
        ? cached : checkpointBefore(cached.checkpoints, afterSeq)
      let offset = from?.offset ?? 0, lines = from?.lines ?? 0, seq = from?.seq ?? 0
      const checkpoints = [...(cached?.checkpoints ?? [])]
      const events: EventEnvelope[] = []
      await scanLines(handle, info.size, offset, runId, (line, end, complete) => {
        if (!complete) return true
        offset = end
        lines++
        const legacy = legacyThinkingSeq(line)
        if (legacy !== undefined) seq = Math.max(seq, legacy)
        else if (line.trim()) {
          try {
            const envelope: unknown = JSON.parse(line)
            if (!isEnvelope(envelope, runId)) throw new Error('事件信封结构或 runId 不合法')
            // read 允许非连续 seq；检查点记录前缀最大值，才能安全跳过整个前缀。
            seq = Math.max(seq, envelope.seq)
            if (afterSeq === undefined || envelope.seq > afterSeq) events.push(envelope)
          } catch (err) {
            throw new Error(`事件日志第 ${lines} 行不是合法事件：${eventsFile(this.taktDir, runId)}`, { cause: err })
          }
        }
        if (lines % 1000 === 0 && offset > (checkpoints.at(-1)?.offset ?? 0)) checkpoints.push({ offset, lines, seq })
        return true
      })
      state.read = { ...fileStamp(info), offset, lines, seq, checkpoints }
      return events
    } finally { await handle.close() }
  }
}

/**
 * 旧版 claude-code 解析器把每个 thinking token 记成一条 harness.message（5bf083e 起不再写入）。一次长运行能攒下
 * 几十万条、几百 MB，读取时整份解析会把 serve 撑到堆上限崩溃。读取时不解析、不返回它们，只取 seq 维持检查点；
 * 哈希链校验照常逐行计入。按旧解析器写出的 data 前缀精确匹配，真实事件不会命中。
 */
const LEGACY_THINKING = '"data":{"role":"system","text":"{\\"type\\":\\"system\\",\\"subtype\\":\\"thinking_tokens\\"'
function legacyThinkingSeq(line: string): number | undefined {
  if (!line.includes(LEGACY_THINKING) || !line.includes('"type":"harness.message"')) return undefined
  const match = /^\{"seq":(\d+),/.exec(line)
  return match ? Number(match[1]) : undefined
}
