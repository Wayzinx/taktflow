import { closeSync, createReadStream, fstatSync, openSync, readSync, type Stats } from 'node:fs'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { open, readFile, stat, type FileHandle } from 'node:fs/promises'
import { createGunzip } from 'node:zlib'
import { subscribeJsonLines } from './jsonl-tail.js'
import type { EventStore } from '../interfaces.js'
import type { EventEnvelope, EventPayloads, EventType } from '../types.js'
import { chainHash, ZERO_HASH } from '../quality/chain.js'
import { appendLine, isEnoent } from './fs-utils.js'
import { withFileLock } from './file-lock.js'
import { withLock } from './locks.js'
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
interface ReadTail extends FileStamp, Checkpoint {
  checkpoints: Checkpoint[]
  /** 从文件开头到 offset 的全部事件（已跳过旧版 thinking 行）；有它时读取只解析新追加的字节。 */
  events?: EventEnvelope[]
  eventBytes?: number
  /** 大到进不了常驻缓存：之后按节点读取只解析含该 nodeId 的行 */
  oversize?: boolean
}
interface VerifyTail extends FileStamp {
  offset: number; seq: number; hash: string
  /** 压缩过的日志：校验时各归档的签名；归档被换、被删或多了一次压缩就整链重验 */
  archives?: string
}
// 三种状态独立取文件签名：append 只在签名完全相同时复用；read（含检查点）和 verify
// 仅在同 inode 变长或签名未变时复用。任何一方都不能把另一方尚未处理的前缀标为已处理。
const fileTails = new Map<string, { append?: AppendTail; read?: ReadTail; verify?: VerifyTail }>()
function tails(file: string) {
  let value = fileTails.get(file)
  if (!value) { value = {}; fileTails.set(file, value) }
  return value
}

/**
 * 解析好的事件常驻内存：运行页一次打开会并发十来个请求（节点详情、事件、运行详情……），每个都从头解析几百 MB 的
 * 日志会让 serve 排队十几秒。按文件缓存，读时只解析追加部分；总量超过上限按最近使用淘汰（淘汰后退回检查点读取）。
 * 上限默认 256MB、单个文件最多占一半，可用 TAKT_EVENT_CACHE_BYTES 调。
 */
const cacheLimit = () => Number(process.env.TAKT_EVENT_CACHE_BYTES) || 256 * 1024 * 1024
const cachedEventBytes = new Map<string, number>()
function rememberEvents(file: string, bytes: number): boolean {
  cachedEventBytes.delete(file)
  const limit = cacheLimit()
  if (bytes > limit / 2) return false
  cachedEventBytes.set(file, bytes)
  let total = 0
  for (const value of cachedEventBytes.values()) total += value
  for (const [other, value] of cachedEventBytes) {
    if (total <= limit || other === file) break
    const read = fileTails.get(other)?.read
    if (read) { delete read.events; delete read.eventBytes }
    cachedEventBytes.delete(other)
    total -= value
  }
  return true
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

export interface EventVerifyResult { ok: boolean; brokenAt?: number; reason?: string }

async function verifyFile(file: string, runId: string): Promise<EventVerifyResult> {
  let handle
  try { handle = await open(file, 'r') } catch (error) {
    if (!isEnoent(error)) throw error
    fileTails.delete(file)
    if ((await readCompactions(file)).length) return { ok: false, brokenAt: 1, reason: '事件日志缺失，但有压缩记录' }
    return { ok: true }
  }
  try {
    const info = await handle.stat(), state = currentTails(file, info)
    // 压缩过的日志 seq 有空洞：把归档按 seq 并回来整链校验一次，之后归档没变就只校验新追加的部分
    const records = await readCompactions(file)
    const archives = records.length ? await archiveStamp(file, records) : undefined
    if (state.verify?.archives !== archives) delete state.verify
    if (archives && !state.verify) {
      const merged = await verifyCompacted(file, info.size, records, runId)
      if (!merged.ok) return { ok: false, brokenAt: merged.brokenAt, ...(merged.reason ? { reason: merged.reason } : {}) }
      state.verify = { ...fileStamp(info), offset: merged.offset, seq: merged.seq, hash: merged.hash, archives }
    }
    const prefix: VerifyTail = { ...fileStamp(info), offset: state.verify?.offset ?? 0,
      seq: state.verify?.seq ?? 0, hash: state.verify?.hash ?? ZERO_HASH, ...(archives ? { archives } : {}) }
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

/**
 * 事件日志压缩（event-compaction.ts）留下的记录：被归档的行原样移进 gzip 归档，主日志里的 seq、hash 都不变，
 * 只是有空洞。每次压缩追加一条，归档文件名在记录里，和 events.jsonl 同目录。
 */
export interface EventCompactionRecord {
  version: 1
  at: string
  by: EventEnvelope['actor']
  rule: string[]
  /** 归档文件名（同目录），内容是被移走的原行，按 seq 升序 */
  archive: string
  /** 归档的行数 */
  dropped: number
  /** 归档里最小 / 最大的 seq */
  firstSeq: number
  lastSeq: number
  /** 压缩前主日志的字节数和 sha256 */
  originalBytes: number
  originalSha256: string
  /** 归档文件（gzip 后）的字节数和 sha256，校验时比对 */
  archiveBytes: number
  archiveSha256: string
  /** 压缩后主日志的字节数 */
  keptBytes: number
}

export const EVENT_COMPACTION_FILE = 'events.compaction.json'

export async function readCompactions(file: string): Promise<EventCompactionRecord[]> {
  let text: string
  try { text = await readFile(path.join(path.dirname(file), EVENT_COMPACTION_FILE), 'utf8') } catch (error) {
    if (isEnoent(error)) return []
    throw error
  }
  const records: unknown = JSON.parse(text)
  if (!Array.isArray(records) || records.some(r => !isRecord(r) || typeof r.archive !== 'string' || path.basename(r.archive) !== r.archive
    || typeof r.archiveSha256 !== 'string' || !Number.isSafeInteger(r.dropped))) throw new Error(`压缩记录格式不对：${EVENT_COMPACTION_FILE}`)
  return records as EventCompactionRecord[]
}

/** 按字节切行（UTF-8 只在行边界解码）；end 是这一行（含换行）结束处在流里的字节偏移。 */
export async function* streamLines(chunks: AsyncIterable<Buffer> | Iterable<Buffer>): AsyncGenerator<{ line: Buffer; end: number; complete: boolean }> {
  let partial = Buffer.alloc(0), offset = 0
  for await (const chunk of chunks) {
    const bytes = partial.length ? Buffer.concat([partial, chunk]) : chunk
    let start = 0
    for (let end = bytes.indexOf(10); end !== -1; end = bytes.indexOf(10, start)) {
      offset += end - start + 1
      yield { line: bytes.subarray(start, end), end: offset, complete: true }
      start = end + 1
    }
    partial = Buffer.from(bytes.subarray(start))
  }
  if (partial.length) yield { line: partial, end: offset + partial.length, complete: false }
}

async function archiveStamp(file: string, records: EventCompactionRecord[]): Promise<string> {
  const parts: string[] = []
  for (const record of records) {
    try {
      const info = await stat(path.join(path.dirname(file), record.archive))
      parts.push(`${record.archive}:${record.archiveSha256}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`)
    } catch (error) {
      if (!isEnoent(error)) throw error
      parts.push(`${record.archive}:missing`)
    }
  }
  return parts.join('|')
}

export async function fileSha256(file: string): Promise<string> {
  const digest = createHash('sha256')
  for await (const chunk of createReadStream(file)) digest.update(chunk as Buffer)
  return digest.digest('hex')
}

interface Head { seq: number; text: string; value: EventEnvelope; end: number; complete: boolean }
type Source = { next(): Promise<Head | undefined>; name?: string }

/**
 * 主日志和各次压缩的归档按 seq 归并后整链校验，结果与压缩前的原文件逐行校验一致。归档缺失、哈希不对、
 * 行数不对都算失败并写明原因。同一 seq 两边都有且原样相同（压缩写完归档、没来得及换主文件就中断）只计一次。
 * 返回主日志里校验过的完整行结束处，verifyFile 从这里接着做增量校验。
 */
export async function verifyCompacted(file: string, size: number, records: EventCompactionRecord[], runId: string,
  archivesDir = path.dirname(file)): Promise<EventVerifyResult & { offset: number; seq: number; hash: string }> {
  const prefix = { offset: 0, seq: 0, hash: ZERO_HASH }
  const fail = (brokenAt: number, reason?: string) => ({ ok: false, brokenAt, ...(reason ? { reason } : {}), ...prefix })
  for (const record of records) {
    const archive = path.join(archivesDir, record.archive)
    let digest: string
    try { digest = await fileSha256(archive) } catch (error) {
      if (!isEnoent(error)) throw error
      return fail(record.firstSeq, `归档缺失：${record.archive}`)
    }
    if (digest !== record.archiveSha256) return fail(record.firstSeq, `归档被改动：${record.archive}`)
  }
  const source = (chunks: AsyncIterable<Buffer> | Iterable<Buffer>, name?: string): Source & { count: number; bad?: string } => {
    const lines = streamLines(chunks)
    const self = {
      name, count: 0, bad: undefined as string | undefined,
      async next(): Promise<Head | undefined> {
        for (;;) {
          const item = await lines.next()
          if (item.done) return undefined
          const text = item.value.line.toString('utf8')
          if (!text.trim()) continue
          let value: unknown
          try { value = JSON.parse(text) } catch { self.bad = text; return undefined }
          if (!isEnvelope(value, runId)) { self.bad = text; return undefined }
          self.count++
          return { seq: value.seq, text, value, end: item.value.end, complete: item.value.complete }
        }
      },
    }
    return self
  }
  // 提前返回时把还没读完的流都关掉，不留文件句柄
  const streams: { destroy(): void }[] = []
  const opened = <T extends { destroy(): void }>(stream: T) => { streams.push(stream); return stream }
  try {
    const main = source(size ? opened(createReadStream(file, { start: 0, end: size - 1 })) as AsyncIterable<Buffer> : [])
    const archives = records.map(record => {
      const raw = opened(createReadStream(path.join(archivesDir, record.archive)))
      return { record, src: source(raw.pipe(opened(createGunzip())), record.archive) }
    })
    const all = [main, ...archives.map(a => a.src)]
    const heads = await Promise.all(all.map(s => s.next()))
    for (;;) {
      let pick = -1
      for (const [i, head] of heads.entries()) if (head && (pick < 0 || head.seq < heads[pick]!.seq)) pick = i
      // 坏行不知道自己的 seq：别处没有补上下一条时，就把它当作下一条报断链
      const bad = all.find(s => s.bad !== undefined)
      if (bad && (pick < 0 || heads[pick]!.seq !== prefix.seq + 1)) return bad === main ? fail(prefix.seq + 1) : fail(prefix.seq + 1, `归档被改动：${bad.name}`)
      if (pick < 0) break
      const head = heads[pick]!
      // 同一 seq 出现在多处：内容原样相同才算重复，一起前进
      for (const [i, other] of heads.entries()) {
        if (i === pick || !other || other.seq !== head.seq) continue
        if (other.text !== head.text) return fail(head.seq, `归档与主日志在 seq ${head.seq} 内容不一致`)
        if (i === 0) { if (other.complete) prefix.offset = other.end; heads[0] = await main.next() }
        else heads[i] = await all[i]!.next()
      }
      const value = head.value
      if (value.seq !== prefix.seq + 1 || value.prevHash !== prefix.hash || value.hash !== chainHash(value, hashPayload(value))) return fail(prefix.seq + 1)
      // 没有末尾换行的半行只校验，不计入前缀（和 verifyFile 一样）
      if (pick !== 0 || head.complete) { prefix.seq = value.seq; prefix.hash = value.hash }
      if (pick === 0 && head.complete) prefix.offset = head.end
      heads[pick] = await all[pick]!.next()
    }
    for (const { record, src } of archives) if (src.count !== record.dropped) return fail(record.firstSeq, `归档被改动：${record.archive}（行数 ${src.count}，记录 ${record.dropped}）`)
    return { ok: true, ...prefix }
  } finally { for (const stream of streams) stream.destroy() }
}

/** 一组完整行是否接在 from 后面连成链（压缩换文件前补上期间追加的事件用）；断了返回 undefined。 */
export function continueChain(lines: string[], from: { seq: number; hash: string }, runId: string): { seq: number; hash: string } | undefined {
  let tail = from
  for (const line of lines) {
    if (!line.trim()) continue
    let value: unknown
    try { value = JSON.parse(line) } catch { return undefined }
    if (!isEnvelope(value, runId) || value.seq !== tail.seq + 1 || value.prevHash !== tail.hash
      || value.hash !== chainHash(value, hashPayload(value))) return undefined
    tail = { seq: value.seq, hash: value.hash }
  }
  return tail
}

/** 最后一个完整行的 seq（只往回找两个换行，再读行首几十个字节）；没有或认不出时为 0。 */
function tailSeqSync(file: string): number {
  let fd: number
  try { fd = openSync(file, 'r') } catch (error) {
    if (isEnoent(error)) return 0
    throw error
  }
  try {
    const newlines: number[] = []
    const chunk = Buffer.alloc(64 * 1024)
    let position = fstatSync(fd).size
    while (position > 0 && newlines.length < 2) {
      const length = Math.min(chunk.length, position)
      position -= length
      readSync(fd, chunk, 0, length, position)
      for (let i = length - 1; i >= 0 && newlines.length < 2; i--) if (chunk[i] === 10) newlines.push(position + i)
    }
    if (!newlines.length) return 0
    const head = Buffer.alloc(32)
    const read = readSync(fd, head, 0, head.length, newlines.length > 1 ? newlines[1]! + 1 : 0)
    const match = /^\{"seq":(\d+),/.exec(head.subarray(0, read).toString('utf8'))
    return match ? Number(match[1]) : 0
  } finally { closeSync(fd) }
}

/** 压缩换掉主日志后丢掉本进程里关于它的缓存（签名变了也会自动失效，这里只是不等下次 stat）。 */
export function forgetEventFile(file: string): void {
  fileTails.delete(file)
  cachedEventBytes.delete(file)
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
    let events = await this.readEvents(runId, opts?.afterSeq, opts?.nodeId)
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
    // 文件被整份换掉（压缩）时 tail 会从头重读：订阅时已在文件里的、已经推过的事件不再推第二遍
    let last = tailSeqSync(file)
    return subscribeJsonLines<EventEnvelope>(file, (e) => {
      if (e.seq <= last) return
      last = e.seq
      onEvent(e)
    })
  }

  /** 校验哈希链；返回第一处断链的 seq（损坏行按它应有的 seq 报）。压缩过的日志连同归档一起校验。 */
  async verify(runId: string): Promise<EventVerifyResult> {
    return verifyFile(path.resolve(eventsFile(this.taktDir, runId)), runId)
  }

  private readEvents(runId: string, afterSeq?: number, nodeId?: string): Promise<EventEnvelope[]> {
    // 同一文件的读取排队：常驻缓存是共享数组，并发读会把同一段追加解析两遍
    const file = path.resolve(eventsFile(this.taktDir, runId))
    return withLock(`${file}#read`, () => this.readEventsLocked(file, runId, afterSeq, nodeId))
  }

  private async readEventsLocked(file: string, runId: string, afterSeq?: number, nodeId?: string): Promise<EventEnvelope[]> {
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
      // 有常驻缓存就接着它往后读；没有时整份读一遍并建缓存，只有建不了（太大）且带 afterSeq 才走检查点
      const resident = cached?.events
      const from = resident ? cached : afterSeq === undefined || !cached ? undefined : afterSeq >= cached.seq
        ? cached : checkpointBefore(cached.checkpoints, afterSeq)
      // 进不了缓存的大日志按节点读：先按子串挑出可能属于该节点的行再解析，其余只取行首 seq（运行页节点抽屉一次要读四五遍）
      const skim = !resident && cached?.oversize && nodeId !== undefined ? `"nodeId":${JSON.stringify(nodeId)}` : undefined
      const building = !skim && (resident !== undefined || !from || from.offset === 0)
      let offset = from?.offset ?? 0, lines = from?.lines ?? 0, seq = from?.seq ?? 0
      let eventBytes = resident ? cached!.eventBytes ?? 0 : 0
      const checkpoints = [...(cached?.checkpoints ?? [])]
      const events: EventEnvelope[] = resident ?? []
      await scanLines(handle, info.size, offset, runId, (line, end, complete) => {
        if (!complete) return true
        offset = end
        lines++
        const legacy = legacyThinkingSeq(line) ?? (skim && !line.includes(skim) ? leadingSeq(line) : undefined)
        if (legacy !== undefined) seq = Math.max(seq, legacy)
        else if (line.trim()) {
          try {
            const envelope: unknown = JSON.parse(line)
            if (!isEnvelope(envelope, runId)) throw new Error('事件信封结构或 runId 不合法')
            // read 允许非连续 seq；检查点记录前缀最大值，才能安全跳过整个前缀。
            seq = Math.max(seq, envelope.seq)
            if (building) { events.push(envelope); eventBytes += line.length }
            else if (afterSeq === undefined || envelope.seq > afterSeq) events.push(envelope)
          } catch (err) {
            throw new Error(`事件日志第 ${lines} 行不是合法事件：${eventsFile(this.taktDir, runId)}`, { cause: err })
          }
        }
        if (lines % 1000 === 0 && offset > (checkpoints.at(-1)?.offset ?? 0)) checkpoints.push({ offset, lines, seq })
        return true
      })
      const keep = building && rememberEvents(file, eventBytes)
      const oversize = cached?.oversize || (building && !keep)
      state.read = { ...fileStamp(info), offset, lines, seq, checkpoints, ...(keep ? { events, eventBytes } : {}), ...(oversize ? { oversize } : {}) }
      if (!building) return events
      // 缓存数组不外借：调用方拿到的是副本
      return afterSeq === undefined ? events.slice() : events.filter((e) => e.seq > afterSeq)
    } finally { await handle.close() }
  }
}

/**
 * 旧版 claude-code 解析器把每个 thinking token 记成一条 harness.message（5bf083e 起不再写入）。一次长运行能攒下
 * 几十万条、几百 MB，读取时整份解析会把 serve 撑到堆上限崩溃。读取时不解析、不返回它们，只取 seq 维持检查点；
 * 哈希链校验照常逐行计入。按旧解析器写出的 data 前缀精确匹配，真实事件不会命中。
 */
const LEGACY_THINKING = '"data":{"role":"system","text":"{\\"type\\":\\"system\\",\\"subtype\\":\\"thinking_tokens\\"'
/** append 写出的行以 {"seq":N, 开头：不解析整行就能拿到 seq */
function leadingSeq(line: string): number | undefined {
  const match = /^\{"seq":(\d+),/.exec(line)
  return match ? Number(match[1]) : undefined
}

export function legacyThinkingSeq(line: string): number | undefined {
  if (!line.includes(LEGACY_THINKING) || !line.includes('"type":"harness.message"')) return undefined
  const match = /^\{"seq":(\d+),/.exec(line)
  return match ? Number(match[1]) : undefined
}
