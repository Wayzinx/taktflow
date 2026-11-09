import { appendFile, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { EventEnvelope } from '../types.js'
import { chainHash, verifyChain, ZERO_HASH } from '../quality/chain.js'
import { FsEventStore } from './fs-events.js'
import { eventsFile } from './paths.js'

const runId = 'run-incremental'
const input = { type: 'log', actor: { type: 'system', id: '测试' }, data: { level: 'info', message: '中文事件' } } as const
let root: string, file: string, store: FsEventStore
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'takt-events-incremental-'))
  file = eventsFile(root, runId)
  store = new FsEventStore(root)
  await mkdir(dirname(file), { recursive: true })
})
afterEach(async () => { vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }) })

function payload(e: EventEnvelope) {
  const { hash: _hash, prevHash: _prev, ...value } = e
  return value
}
function chain(count: number): EventEnvelope[] {
  let prevHash = ZERO_HASH
  return Array.from({ length: count }, (_, i) => {
    const e: EventEnvelope = { ...input, runId, seq: i + 1, ts: '2026-11-09T00:00:00.000Z', prevHash, hash: '' }
    e.hash = chainHash(e)
    prevHash = e.hash
    return e
  })
}
const text = (events: EventEnvelope[]) => events.map(e => JSON.stringify(e)).join('\n') + '\n'
const reference = (content: string) => {
  const { brokenAt } = verifyChain(content, (e): e is EventEnvelope => typeof e === 'object' && e !== null && 'seq' in e, {
    ignoreBlankLines: true, requireFinalNewline: false,
    payload: e => { const { extra: _extra, ...value } = payload(e) as Record<string, unknown>; return value },
  })
  return brokenAt === undefined ? { ok: true } : { ok: false, brokenAt }
}

it('已校验前缀不重解析，读取/追加缓存不能代替校验缓存', async () => {
  await writeFile(file, text(chain(2000)))
  await store.read(runId)
  expect(await store.verify(runId)).toEqual({ ok: true })
  const next = await store.append(runId, input)
  await store.read(runId)
  const parse = vi.spyOn(JSON, 'parse')
  expect(await store.verify(runId)).toEqual({ ok: true })
  // 信封解析一次，哈希规范化再解析一次；已校验的 2000 条不再解析。
  expect(parse).toHaveBeenCalledTimes(2)
  expect(JSON.parse(parse.mock.calls[0]![0])).toEqual(next)
  parse.mockClear()
  expect(await store.verify(runId)).toEqual({ ok: true })
  expect(parse).not.toHaveBeenCalled()
})

it('半行每次重新校验，合法无换行尾部、空行和额外字段与整文件语义一致', async () => {
  const events = chain(3)
  const first = '\n' + JSON.stringify({ ...events[0], extra: '旧格式字段' }) + '\n \r\n'
  await writeFile(file, first)
  expect(await store.verify(runId)).toEqual(reference(first))
  const last = JSON.stringify(events[1])
  await appendFile(file, last.slice(0, -2))
  for (let i = 0; i < 2; i++) expect(await store.verify(runId)).toEqual({ ok: false, brokenAt: 2 })
  await appendFile(file, last.slice(-2))
  for (let i = 0; i < 2; i++) expect(await store.verify(runId)).toEqual(reference(first + last))
  expect(await store.read(runId)).toHaveLength(1)
  await appendFile(file, '\n\n' + JSON.stringify(events[2]))
  expect(await store.verify(runId)).toEqual(reference(await readFile(file, 'utf8')))
  await appendFile(file, '\n')
  expect(await store.verify(runId)).toEqual({ ok: true })
  expect(await store.read(runId)).toHaveLength(3)
})

it('无换行尾部跨块 UTF-8 不被截断，补换行后才进入前缀', async () => {
  const event = chain(1)[0]!
  event.data = { level: 'info', message: '你'.repeat(30000) }
  event.hash = chainHash(event)
  await writeFile(file, JSON.stringify(event))
  expect(await store.verify(runId)).toEqual({ ok: true })
  await appendFile(file, '\n')
  expect(await store.verify(runId)).toEqual({ ok: true })
  expect(await store.read(runId)).toEqual([event])
})

it.each(['replace', 'truncate', 'same-size'] as const)('%s 后完整回退，中间坏行与整文件相同且重复结果稳定', async mode => {
  const events = chain(3000)
  await writeFile(file, text(events))
  await store.verify(runId)
  await store.read(runId)
  const changed = events.slice(0, mode === 'truncate' ? 2000 : 3000)
  changed[1234] = { ...changed[1234]!, hash: 'f'.repeat(64) }
  const content = text(changed)
  if (mode === 'replace') { await writeFile(file + '.new', content); await rename(file + '.new', file) }
  else await writeFile(file, content)
  for (let i = 0; i < 3; i++) expect(await store.verify(runId)).toEqual(reference(content))
  expect(await store.verify(runId)).toEqual({ ok: false, brokenAt: 1235 })
  // 替换/截断时旧检查点也失效。
  expect(await store.read(runId, { afterSeq: 1500 })).toEqual(changed.filter(e => e.seq > 1500))
  await writeFile(file, text(events))
  expect(await store.verify(runId)).toEqual({ ok: true })
})

it.each(['prevHash', 'seq', 'json'] as const)('增量首行 %s 损坏不缓存坏位置，后续追加也稳定报断链', async kind => {
  const events = chain(3)
  await writeFile(file, text(events.slice(0, 1)))
  expect(await store.verify(runId)).toEqual({ ok: true })
  const bad = { ...events[1]!, ...(kind === 'prevHash' ? { prevHash: ZERO_HASH } : { seq: 9 }) }
  bad.hash = chainHash(bad)
  await appendFile(file, kind === 'json' ? '{坏行}\n' : text([bad]))
  expect(await store.verify(runId)).toEqual({ ok: false, brokenAt: 2 })
  await appendFile(file, text(events.slice(2)))
  expect(await store.verify(runId)).toEqual(reference(await readFile(file, 'utf8')))
  expect(await store.verify(runId)).toEqual({ ok: false, brokenAt: 2 })
})

it('不同消费者交替补读、全读和新增，检查点结果等同完整过滤', async () => {
  const events = chain(4200)
  await writeFile(file, '\n' + text(events.slice(0, 4000)))
  const other = new FsEventStore(root)
  expect(await store.read(runId)).toEqual(events.slice(0, 4000))
  await appendFile(file, text(events.slice(4000)))
  for (const cursor of [4000, 3500, 4100, 1999, 2000, 0, -1, 4200, 999]) {
    expect(await other.read(runId, { afterSeq: cursor })).toEqual(events.filter(e => e.seq > cursor))
    expect(await store.read(runId, { afterSeq: 4190 })).toEqual(events.slice(4190))
  }
  expect(await other.read(runId)).toEqual(events)
  const parse = vi.spyOn(JSON, 'parse')
  expect(await store.read(runId, { afterSeq: 4100 })).toEqual(events.slice(4100))
  expect(parse.mock.calls.length).toBeLessThanOrEqual(1000)
})

it('检查点保留非单调 seq 的旧读取语义，并保留坏行的物理行号', async () => {
  const events = chain(2500)
  events[10] = { ...events[10]!, seq: 9999 }
  await writeFile(file, text(events))
  await store.read(runId)
  expect(await store.read(runId, { afterSeq: 2300 })).toEqual(events.filter(e => e.seq > 2300))
  await writeFile(file, text(chain(2500)))
  await store.read(runId)
  await appendFile(file, '\n{坏行}\n')
  await expect(store.read(runId, { afterSeq: 2001 })).rejects.toThrow(`事件日志第 2502 行不是合法事件：${file}`)
})

it.each(['replace', 'truncate', 'same-size'] as const)('%s 使稀疏检查点失效，不遗漏旧边界之前的新事件', async mode => {
  const events = chain(3000)
  await writeFile(file, text(events))
  await store.read(runId)
  const replacement = events.slice(0, mode === 'truncate' ? 2500 : 3000)
  replacement[1100] = { ...replacement[1100]!, seq: 9999 }
  if (mode === 'replace') { await writeFile(file + '.new', text(replacement)); await rename(file + '.new', file) }
  else await writeFile(file, text(replacement))
  expect(await store.read(runId, { afterSeq: 2400 })).toEqual(replacement.filter(e => e.seq > 2400))
})

it('5 万行追加 100 次逐次校验、两个游标各补读 100 次，分别小于 1 秒', async () => {
  await writeFile(file, text(chain(50000)))
  expect(await store.verify(runId)).toEqual({ ok: true })
  await store.read(runId)
  const verifyStart = performance.now()
  for (let i = 0; i < 100; i++) {
    await store.append(runId, input)
    expect(await store.verify(runId)).toEqual({ ok: true })
  }
  const verifyMs = performance.now() - verifyStart
  expect(verifyMs).toBeLessThan(1000)
  await store.read(runId)
  const other = new FsEventStore(root)
  const readStart = performance.now()
  for (let i = 0; i < 100; i++) {
    expect(await store.read(runId, { afterSeq: 50100 })).toEqual([])
    const behind = await other.read(runId, { afterSeq: 49600 })
    expect(behind).toHaveLength(500)
    expect(behind[0]!.seq).toBe(49601)
    expect(behind.at(-1)!.seq).toBe(50100)
  }
  const readMs = performance.now() - readStart
  expect(readMs).toBeLessThan(1000)
  console.log(`增量性能：100 次追加并校验 ${verifyMs.toFixed(0)}ms；双游标各 100 次 ${readMs.toFixed(0)}ms`)
})
