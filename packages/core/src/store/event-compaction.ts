import { createReadStream, createWriteStream, type WriteStream } from 'node:fs'
import { createHash, randomBytes } from 'node:crypto'
import { once } from 'node:events'
import { open, rename, rm, stat, writeFile, type FileHandle } from 'node:fs/promises'
import path from 'node:path'
import { Transform, type Writable } from 'node:stream'
import { finished, pipeline } from 'node:stream/promises'
import { createGzip } from 'node:zlib'
import type { ProjectStores } from '../interfaces.js'
import type { Actor } from '../types.js'
import { EVENT_COMPACTION_FILE, FsEventStore, continueChain, forgetEventFile, legacyThinkingSeq, readCompactions, streamLines, verifyCompacted,
  type EventCompactionRecord, type EventVerifyResult } from './fs-events.js'
import { withFileLock } from './file-lock.js'
import { withLock } from './locks.js'
import { isEnoent, toJsonText } from './fs-utils.js'
import { eventsFile } from './paths.js'

/**
 * 运行事件日志压缩：把噪声行原样移进 gzip 归档，主日志只留其余行。seq、hash 一律不动（质量观察 ID、Lead 投影
 * 都按 seq 引用事件），所以主日志 seq 有空洞、下一条保留事件的 prevHash 指向被归档的那条；verify 把归档按 seq
 * 并回来整链校验（fs-events.ts 的 verifyCompacted）。设计见 docs/design/05 「压缩与归档」。
 */
export type EventCompactionRule = 'thinking_tokens' | 'acp-thought-chunks'

export const EVENT_COMPACTION_RULES: Record<EventCompactionRule, string> = {
  thinking_tokens: '旧版 Claude Code 每个 thinking token 记一条的噪声行（读取时本来就跳过）',
  'acp-thought-chunks': `ACP 思考按 token 一条条记下的片段串（同一次调用连续 ≥ 20 条）；归档后运行页不再显示这段思考，归档里原样保留`,
}

/** 同一次调用连续这么多条 ACP 思考片段才归档；386247d 之后攒好的整段思考一条一记，不会凑够 */
export const ACP_THOUGHT_STREAK = 20
const ACP_THOUGHT = '"data":{"role":"system","text":"[ACP thought] '
const SEQ_PREFIX = /^\{"seq":(\d+),/
const NEWLINE = Buffer.from('\n')

export class EventCompactionError extends Error {}

export interface EventCompactionResult {
  runId: string
  rules: EventCompactionRule[]
  dryRun: boolean
  /** 归档（或 dry-run 时将归档）的行数，按规则分 */
  dropped: number
  byRule: Partial<Record<EventCompactionRule, number>>
  originalBytes: number
  /** dry-run 时是预计值 */
  keptBytes: number
  /** 归档的是真实思考文本（acp-thought-chunks 命中）：运行页不再显示这些思考 */
  hidesThinking: boolean
  record?: EventCompactionRecord
  verify?: EventVerifyResult
}

interface Plan {
  drop: Set<number>
  byRule: Partial<Record<EventCompactionRule, number>>
  droppedBytes: number
  lastSeq: number
}

export async function compactRunEvents(stores: Pick<ProjectStores, 'taktDir' | 'runs'>, runId: string,
  opts: { rules?: EventCompactionRule[]; dryRun?: boolean; by: Actor; now?: () => Date
    /** 第一遍数完、动手改写之前回调（CLI 先打印摘要） */
    onPlan?: (plan: EventCompactionResult) => void }): Promise<EventCompactionResult> {
  const rules = [...new Set(opts.rules?.length ? opts.rules : ['thinking_tokens' as const])]
  for (const rule of rules) if (!Object.hasOwn(EVENT_COMPACTION_RULES, rule)) throw new EventCompactionError(`未知的压缩规则：${rule}（可选 ${Object.keys(EVENT_COMPACTION_RULES).join(' / ')}）`)
  const run = await stores.runs.get(runId)
  if (!run) throw new EventCompactionError(`运行不存在：${runId}`)
  // 运行中的事件还在一条条追加，换文件那一下虽然在锁里，但没必要冒这个险
  if (run.status === 'running') throw new EventCompactionError(`运行 ${runId} 还在跑，等它结束、等人或取消后再压缩`)
  const file = path.resolve(eventsFile(stores.taktDir, runId))
  return withLock(`${file}#compact`, async () => {
    let handle: FileHandle
    try { handle = await open(file, 'r') } catch (error) {
      if (isEnoent(error)) throw new EventCompactionError(`运行 ${runId} 没有事件日志`)
      throw error
    }
    // 两遍都读同一个打开的文件、同一段字节：期间追加的事件留到换文件时补上
    let snapshot: { ino: number; size: number }, plan: Plan
    try {
      const info = await handle.stat()
      snapshot = { ino: info.ino, size: info.size }
      plan = await classify(handle, snapshot.size, rules)
    } catch (error) { await handle.close(); throw error }
    const result: EventCompactionResult = {
      runId, rules, dryRun: opts.dryRun === true, dropped: plan.drop.size, byRule: plan.byRule,
      originalBytes: snapshot.size, keptBytes: snapshot.size - plan.droppedBytes, hidesThinking: (plan.byRule['acp-thought-chunks'] ?? 0) > 0,
    }
    if (opts.dryRun || !plan.drop.size) { await handle.close(); return result }
    opts.onPlan?.({ ...result })
    try {
      result.record = await rewrite(handle, file, runId, snapshot, plan, rules, opts.by, opts.now?.() ?? new Date())
    } finally { await handle.close() }
    result.keptBytes = result.record.keptBytes
    result.verify = await new FsEventStore(stores.taktDir).verify(runId)
    return result
  })
}

/** 第一遍：只认行首的 seq 和少量子串，候选行才解析 JSON；记下要归档的 seq。 */
async function classify(handle: FileHandle, size: number, rules: EventCompactionRule[]): Promise<Plan> {
  const plan: Plan = { drop: new Set(), byRule: {}, droppedBytes: 0, lastSeq: 0 }
  const thinking = rules.includes('thinking_tokens'), acp = rules.includes('acp-thought-chunks')
  const mark = (seq: number, bytes: number, rule: EventCompactionRule) => {
    plan.drop.add(seq)
    plan.droppedBytes += bytes
    plan.byRule[rule] = (plan.byRule[rule] ?? 0) + 1
  }
  // 每次调用当前这串 ACP 思考片段；同一调用出现别的事件就结束这一串，凑够条数才归档
  const streaks = new Map<string, { seq: number; bytes: number }[]>()
  const flush = (invocation: string, keep?: number) => {
    const streak = streaks.get(invocation)
    streaks.delete(invocation)
    if (!streak || streak.length < ACP_THOUGHT_STREAK) return
    for (const item of streak) if (item.seq !== keep) mark(item.seq, item.bytes, 'acp-thought-chunks')
  }
  let lastThinking: { seq: number; bytes: number } | undefined
  for await (const { line, complete } of streamLines(size ? handle.createReadStream({ start: 0, end: size - 1, autoClose: false }) : [])) {
    if (!complete) throw new EventCompactionError('事件日志末尾不完整（没有换行），先用 takt audit verify 查清再压缩')
    const text = line.toString('utf8')
    const seq = SEQ_PREFIX.exec(text)?.[1]
    if (seq === undefined) continue
    plan.lastSeq = Number(seq)
    const bytes = line.length + 1
    if (thinking && legacyThinkingSeq(text) !== undefined) {
      mark(plan.lastSeq, bytes, 'thinking_tokens')
      lastThinking = { seq: plan.lastSeq, bytes }
      continue
    }
    if (!acp) continue
    const invocation = /"invocationId":"([^"\\]+)"/.exec(text)?.[1]
    if (invocation === undefined) continue
    if (text.includes(ACP_THOUGHT) && text.includes('"type":"harness.message"') && isAcpThought(text)) {
      let streak = streaks.get(invocation)
      if (!streak) streaks.set(invocation, streak = [])
      streak.push({ seq: plan.lastSeq, bytes })
    } else flush(invocation)
  }
  // 最后一行永远留在主日志：追加时只读最后一行接链
  for (const invocation of [...streaks.keys()]) flush(invocation, plan.lastSeq)
  if (lastThinking?.seq === plan.lastSeq) {
    plan.drop.delete(lastThinking.seq)
    plan.droppedBytes -= lastThinking.bytes
    plan.byRule.thinking_tokens! -= 1
  }
  return plan
}

function isAcpThought(text: string): boolean {
  try {
    const value = JSON.parse(text) as { type?: unknown; actor?: { invocationId?: unknown }; data?: { role?: unknown; text?: unknown } }
    return value.type === 'harness.message' && value.data?.role === 'system' && typeof value.data.text === 'string'
      && value.data.text.startsWith('[ACP thought] ') && typeof value.actor?.invocationId === 'string'
  } catch { return false }
}

/** 攒到 1MB 再写，写不动就等 drain。 */
function batched(stream: Writable) {
  let parts: Buffer[] = [], size = 0
  const flush = async () => {
    if (!size) return
    const ok = stream.write(Buffer.concat(parts, size))
    parts = []
    size = 0
    if (!ok) await once(stream, 'drain')
  }
  return {
    async line(bytes: Buffer) {
      parts.push(bytes, NEWLINE)
      size += bytes.length + 1
      if (size >= 1 << 20) await flush()
    },
    flush,
  }
}

async function fsyncFile(file: string): Promise<void> {
  const handle = await open(file, 'r+')
  try { await handle.sync() } finally { await handle.close() }
}

async function fsyncDir(dir: string): Promise<void> {
  // 有的平台不能 fsync 目录：rename 已经落盘的文件内容不受影响，这里尽力而为
  try {
    const handle = await open(dir, 'r')
    try { await handle.sync() } finally { await handle.close() }
  } catch {}
}

async function freeArchiveName(dir: string, records: EventCompactionRecord[]): Promise<string> {
  // 归档写好、记录没来得及写就中断时会留下没登记的归档：跳过它，不覆盖
  for (let n = records.length + 1; ; n++) {
    const name = `events.archive.${n}.jsonl.gz`
    if (records.some(r => r.archive === name)) continue
    try { await stat(path.join(dir, name)) } catch (error) {
      if (isEnoent(error)) return name
      throw error
    }
  }
}

/**
 * 第二遍：保留行写临时主日志、归档行写临时 gzip，fsync 后连同已有归档整链校验；通过了才在运行文件锁里
 * 补上期间追加的事件、依次换上归档 → 记录 → 主日志。任何一步失败都不动原文件，临时文件删掉。
 * 换文件的顺序保证中途中断也校验得过：记录在、主日志还是旧的时，重复的行原样相同，verify 只计一次。
 */
async function rewrite(handle: FileHandle, file: string, runId: string, snapshot: { ino: number; size: number }, plan: Plan,
  rules: EventCompactionRule[], by: Actor, at: Date): Promise<EventCompactionRecord> {
  const dir = path.dirname(file)
  const records = await readCompactions(file)
  const archive = await freeArchiveName(dir, records)
  const suffix = `${process.pid}.${randomBytes(4).toString('hex')}.tmp`
  const keptTmp = `${file}.compact.${suffix}`, archiveTmp = path.join(dir, `${archive}.${suffix}`)
  try {
    const original = createHash('sha256'), archived = createHash('sha256')
    let archiveBytes = 0, archivedLines = 0, firstSeq = 0, lastSeq = 0
    const kept: WriteStream = createWriteStream(keptTmp, { flags: 'wx' })
    const gzip = createGzip()
    const tap = new Transform({ transform(chunk: Buffer, _encoding, done) { archived.update(chunk); archiveBytes += chunk.length; done(null, chunk) } })
    const archiveDone = pipeline(gzip, tap, createWriteStream(archiveTmp, { flags: 'wx' }))
    archiveDone.catch(() => {})
    const keep = batched(kept), move = batched(gzip)
    async function* hashed() {
      for await (const chunk of handle.createReadStream({ start: 0, end: snapshot.size - 1, autoClose: false })) {
        original.update(chunk as Buffer)
        yield chunk as Buffer
      }
    }
    for await (const { line } of streamLines(hashed())) {
      const seq = Number(SEQ_PREFIX.exec(line.subarray(0, 32).toString('utf8'))?.[1] ?? 0)
      if (seq && plan.drop.has(seq)) {
        await move.line(line)
        archivedLines++
        if (!firstSeq) firstSeq = seq
        lastSeq = seq
      } else await keep.line(line)
    }
    await keep.flush()
    kept.end()
    await finished(kept)
    await move.flush()
    gzip.end()
    await archiveDone
    if (archivedLines !== plan.drop.size) throw new EventCompactionError(`两遍读到的事件对不上（${archivedLines} / ${plan.drop.size}），日志可能在压缩时被改动，没有替换`)
    await fsyncFile(keptTmp)
    await fsyncFile(archiveTmp)
    const record: EventCompactionRecord = {
      version: 1, at: at.toISOString(), by, rule: rules, archive, dropped: archivedLines, firstSeq, lastSeq,
      originalBytes: snapshot.size, originalSha256: original.digest('hex'), archiveBytes, archiveSha256: archived.digest('hex'),
      keptBytes: (await stat(keptTmp)).size,
    }
    // 新主日志 + 全部归档并回来必须和原文件是同一条链、链尾也相同
    const merged = await verifyCompacted(keptTmp, record.keptBytes, [...records, { ...record, archive: path.basename(archiveTmp) }], runId, dir)
    if (!merged.ok) throw new EventCompactionError(`压缩结果校验没通过（第 ${merged.brokenAt} 条${merged.reason ? `：${merged.reason}` : ''}），原文件没动；如果压缩前就断链，先用 takt audit verify 查清`)
    if (merged.seq !== plan.lastSeq) throw new EventCompactionError(`压缩结果的链尾（${merged.seq}）和原文件（${plan.lastSeq}）不一致，原文件没动`)
    await withFileLock(file, async () => {
      const now = await stat(file)
      if (now.ino !== snapshot.ino || now.size < snapshot.size) throw new EventCompactionError('压缩期间事件日志被替换或截断，没有替换')
      if (now.size > snapshot.size) {
        // 压缩期间又追加的事件：接在原链尾后面原样补上
        const extra = Buffer.alloc(now.size - snapshot.size)
        await handle.read(extra, 0, extra.length, snapshot.size)
        const text = extra.toString('utf8')
        if (!text.endsWith('\n') || !continueChain(text.slice(0, -1).split('\n'), merged, runId)) throw new EventCompactionError('压缩期间追加的事件没接上链，没有替换')
        await writeFile(keptTmp, extra, { flag: 'a' })
        await fsyncFile(keptTmp)
        record.keptBytes += extra.length
      }
      await rename(archiveTmp, path.join(dir, archive))
      const recordsFile = path.join(dir, EVENT_COMPACTION_FILE), recordsTmp = `${recordsFile}.${suffix}`
      await writeFile(recordsTmp, toJsonText([...records, record]), { flag: 'wx' })
      await fsyncFile(recordsTmp)
      await rename(recordsTmp, recordsFile)
      await rename(keptTmp, file)
      await fsyncDir(dir)
      forgetEventFile(file)
    })
    return record
  } finally {
    await rm(keptTmp, { force: true })
    await rm(archiveTmp, { force: true })
  }
}
