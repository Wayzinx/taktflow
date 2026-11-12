import { copyFile, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { gunzipSync, gzipSync } from 'node:zlib'
import { afterEach, beforeEach, expect, it } from 'vitest'
import type { EventEnvelope, RunStatus } from '../types.js'
import { ACP_THOUGHT_STREAK, compactRunEvents, EventCompactionError } from './event-compaction.js'
import { EVENT_COMPACTION_FILE, FsEventStore, readCompactions } from './fs-events.js'
import { eventsFile } from './paths.js'

const runId = 'run-20261112-000001'
const by = { type: 'human', id: 'alice' } as const
let root: string, taktDir: string, file: string, store: FsEventStore, status: RunStatus
const stores = () => ({ taktDir, runs: { get: async (id: string) => (id === runId ? { status } : undefined) } }) as unknown as Parameters<typeof compactRunEvents>[0]

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'takt-compact-'))
  taktDir = path.join(root, '.takt')
  file = eventsFile(taktDir, runId)
  store = new FsEventStore(taktDir)
  status = 'succeeded'
})
afterEach(() => rm(root, { recursive: true, force: true }))

const log = (message: string, nodeId?: string) => store.append(runId, { type: 'log', actor: { type: 'system', id: 'test' }, ...(nodeId ? { nodeId } : {}), data: { level: 'info', message } })
const thinking = (n: number) => store.append(runId, {
  type: 'harness.message', actor: { type: 'agent', role: 'pm', harness: 'claude-code' },
  data: { role: 'system', text: JSON.stringify({ type: 'system', subtype: 'thinking_tokens', estimated_tokens: n, estimated_tokens_delta: 1 }) },
})
const acp = (invocationId: string, text: string, role: 'system' | 'assistant' = 'system') => store.append(runId, {
  type: 'harness.message', actor: { type: 'agent', role: 'dev', harness: 'claude-acp', invocationId },
  data: { role, text: role === 'system' ? `[ACP thought] ${JSON.stringify({ type: 'text', text })}` : text },
})
const tool = (invocationId: string) => store.append(runId, {
  type: 'harness.tool_call', actor: { type: 'agent', role: 'dev', harness: 'claude-acp', invocationId }, data: { tool: 'Read', input: {} },
} as never)
const lines = async () => (await readFile(file, 'utf8')).split('\n').filter(Boolean)
const seqOf = (line: string) => (JSON.parse(line) as EventEnvelope).seq
const archived = async (n = 1) => gunzipSync(await readFile(path.join(path.dirname(file), `events.archive.${n}.jsonl.gz`))).toString('utf8').split('\n').filter(Boolean)

it('thinking_tokens：噪声行原样进归档，保留行字节、seq、hash 不变；verify 并回归档后整链通过', async () => {
  await log('开始')
  for (let n = 1; n <= 30; n++) await thinking(n)
  await store.append(runId, { type: 'harness.message', actor: { type: 'agent', role: 'pm', harness: 'claude-code' }, data: { role: 'assistant', text: '{"type":"system","subtype":"thinking_tokens"}' } })
  for (let n = 31; n <= 40; n++) await thinking(n)
  await log('结束')
  const before = await lines()
  const readBefore = await store.read(runId)

  const result = await compactRunEvents(stores(), runId, { by, now: () => new Date('2026-11-12T00:00:00Z') })
  expect(result).toMatchObject({ dropped: 40, byRule: { thinking_tokens: 40 }, hidesThinking: false, verify: { ok: true } })
  const after = await lines()
  expect(after).toEqual(before.filter((_, i) => ![...Array(30).keys()].map(k => k + 1).concat([...Array(10).keys()].map(k => k + 32)).includes(i)))
  expect(after.map(seqOf)).toEqual([1, 32, 43])
  expect(await archived()).toEqual(before.filter(line => !after.includes(line)))
  const [record] = await readCompactions(file)
  expect(record).toMatchObject({ version: 1, at: '2026-11-12T00:00:00.000Z', by, rule: ['thinking_tokens'], archive: 'events.archive.1.jsonl.gz', dropped: 40, firstSeq: 2, lastSeq: 42, originalBytes: Buffer.byteLength(`${before.join('\n')}\n`), keptBytes: Buffer.byteLength(`${after.join('\n')}\n`) })
  expect(result.keptBytes).toBe(record!.keptBytes)

  // 读取、游标跨空洞、冷缓存校验、压缩后接着追加
  expect(await store.read(runId)).toEqual(readBefore)
  expect((await store.read(runId, { afterSeq: 5 })).map(e => e.seq)).toEqual([32, 43])
  expect(await new FsEventStore(taktDir).verify(runId)).toEqual({ ok: true })
  const next = await log('压缩之后')
  expect(next.seq).toBe(44)
  expect(next.prevHash).toBe(JSON.parse(after.at(-1)!).hash)
  expect(await store.verify(runId)).toEqual({ ok: true })
  expect(await new FsEventStore(taktDir).verify(runId)).toEqual({ ok: true })
})

it('归档被改动或缺失：verify 失败并写明原因', async () => {
  await log('开始')
  for (let n = 1; n <= 5; n++) await thinking(n)
  await log('结束')
  await compactRunEvents(stores(), runId, { by })
  const archive = path.join(path.dirname(file), 'events.archive.1.jsonl.gz')
  const original = await readFile(archive)
  await writeFile(archive, gzipSync(gunzipSync(original).toString('utf8').replace('"estimated_tokens\\":3', '"estimated_tokens\\":4')))
  expect(await new FsEventStore(taktDir).verify(runId)).toMatchObject({ ok: false, brokenAt: 2, reason: '归档被改动：events.archive.1.jsonl.gz' })
  await rm(archive)
  expect(await new FsEventStore(taktDir).verify(runId)).toMatchObject({ ok: false, brokenAt: 2, reason: '归档缺失：events.archive.1.jsonl.gz' })
  // 归档原样放回又能通过；没有压缩记录的老日志仍要求 seq 连续
  await writeFile(archive, original)
  expect(await new FsEventStore(taktDir).verify(runId)).toEqual({ ok: true })
  await rm(path.join(path.dirname(file), EVENT_COMPACTION_FILE))
  expect(await new FsEventStore(taktDir).verify(runId)).toEqual({ ok: false, brokenAt: 2 })
})

it('运行中拒绝；dry-run 只报数不改文件；没有可压缩的行时什么也不写', async () => {
  await log('开始')
  for (let n = 1; n <= 5; n++) await thinking(n)
  await log('结束')
  const before = await readFile(file)
  status = 'running'
  await expect(compactRunEvents(stores(), runId, { by })).rejects.toBeInstanceOf(EventCompactionError)
  status = 'waiting_human'
  const dry = await compactRunEvents(stores(), runId, { by, dryRun: true })
  expect(dry).toMatchObject({ dryRun: true, dropped: 5, originalBytes: before.length })
  expect(dry.keptBytes).toBeLessThan(before.length)
  expect(dry.record).toBeUndefined()
  expect(await readFile(file)).toEqual(before)
  expect(await readCompactions(file)).toEqual([])
  const none = await compactRunEvents(stores(), runId, { by, rules: ['acp-thought-chunks'] })
  expect(none.dropped).toBe(0)
  expect(await readFile(file)).toEqual(before)
  await expect(compactRunEvents(stores(), 'run-20261112-000002', { by })).rejects.toThrow('运行不存在')
  await expect(compactRunEvents(stores(), runId, { by, rules: ['nope' as never] })).rejects.toThrow('未知的压缩规则')
})

it('acp-thought-chunks 需显式指定：只归档同一调用连续 ≥ 20 条的思考片段串，攒好的整段思考和别的消息不动', async () => {
  await log('开始')
  // A：25 条片段，中间夹着 B 的事件也不打断；B：5 条片段后调工具；C：15 条 → 自己的工具调用 → 15 条，两串都不够
  for (let i = 0; i < 25; i++) {
    await acp('A', `a${i}`)
    if (i < 5) await acp('B', `b${i}`)
    if (i === 5) await tool('B')
  }
  for (let i = 0; i < 15; i++) await acp('C', `c${i}`)
  await tool('C')
  for (let i = 0; i < 15; i++) await acp('C', `d${i}`)
  await acp('D', '这是 386247d 之后攒好的一整段思考')
  await acp('A', '最终回答', 'assistant')
  await log('结束')
  const before = await lines()

  expect((await compactRunEvents(stores(), runId, { by })).dropped).toBe(0)
  const result = await compactRunEvents(stores(), runId, { by, rules: ['acp-thought-chunks'] })
  expect(result).toMatchObject({ dropped: 25, byRule: { 'acp-thought-chunks': 25 }, hidesThinking: true, verify: { ok: true } })
  const gone = await archived()
  expect(gone).toHaveLength(25)
  expect(gone.every(line => (JSON.parse(line) as EventEnvelope).actor.type === 'agent' && line.includes('"invocationId":"A"'))).toBe(true)
  expect(await lines()).toEqual(before.filter(line => !gone.includes(line)))
  expect(ACP_THOUGHT_STREAK).toBe(20)
})

it('最后一行永远留在主日志；两次压缩各留一个归档，verify 一起并回来', async () => {
  await log('开始')
  for (let i = 0; i < 22; i++) await acp('A', `a${i}`)
  for (let n = 1; n <= 3; n++) await thinking(n)
  for (let i = 0; i < 22; i++) await acp('Z', `z${i}`)
  const last = (await lines()).at(-1)!

  expect((await compactRunEvents(stores(), runId, { by })).dropped).toBe(3)
  const second = await compactRunEvents(stores(), runId, { by, rules: ['acp-thought-chunks'] })
  // Z 的 22 条里最后一条是整个文件的最后一行，留下
  expect(second).toMatchObject({ dropped: 43, verify: { ok: true } })
  expect((await lines()).map(seqOf)).toEqual([1, 48])
  expect((await lines()).at(-1)).toBe(last)
  expect((await readCompactions(file)).map(r => [r.archive, r.dropped])).toEqual([['events.archive.1.jsonl.gz', 3], ['events.archive.2.jsonl.gz', 43]])
  expect(await new FsEventStore(taktDir).verify(runId)).toEqual({ ok: true })
  expect((await log('继续')).seq).toBe(49)
  expect(await new FsEventStore(taktDir).verify(runId)).toEqual({ ok: true })
})

it('换文件中途中断（归档和记录已写、主日志还是旧的）：重复行原样相同，verify 只计一次', async () => {
  await log('开始')
  for (let n = 1; n <= 5; n++) await thinking(n)
  await log('结束')
  const original = `${file}.orig`
  await copyFile(file, original)
  await compactRunEvents(stores(), runId, { by })
  await copyFile(original, `${file}.tmp`)
  await rename(`${file}.tmp`, file)
  expect(await new FsEventStore(taktDir).verify(runId)).toEqual({ ok: true })
  // 同一 seq 内容不同则不行
  const text = await readFile(original, 'utf8')
  await writeFile(`${file}.tmp`, text.replace('"estimated_tokens\\":2', '"estimated_tokens\\":9'))
  await rename(`${file}.tmp`, file)
  expect(await new FsEventStore(taktDir).verify(runId)).toMatchObject({ ok: false, brokenAt: 3 })
})

it('原链已断就拒绝压缩，原文件不动', async () => {
  await log('开始')
  for (let n = 1; n <= 5; n++) await thinking(n)
  await log('结束')
  const text = await readFile(file, 'utf8')
  await writeFile(file, text.replace('"message":"开始"', '"message":"改过"'))
  const broken = await readFile(file)
  await expect(compactRunEvents(stores(), runId, { by })).rejects.toThrow('压缩结果校验没通过')
  expect(await readFile(file)).toEqual(broken)
  expect(await readCompactions(file)).toEqual([])
})

it('订阅中的文件被压缩换掉：不重推已有事件，之后追加的照常推', async () => {
  await log('开始')
  for (let n = 1; n <= 5; n++) await thinking(n)
  const seen: number[] = []
  const stop = store.subscribe(runId, e => seen.push(e.seq))
  try {
    await log('订阅后')
    await new Promise(resolve => setTimeout(resolve, 400))
    await compactRunEvents(stores(), runId, { by })
    await log('压缩后')
    await new Promise(resolve => setTimeout(resolve, 700))
    expect(seen).toEqual([7, 8])
  } finally { stop() }
})
