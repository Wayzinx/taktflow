import { appendFile, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EventEnvelope } from '../types.js'
import { FsEventStore } from './fs-events.js'
import { eventsFile } from './paths.js'
import { canonicalJson, sha256 } from '../util/hash.js'

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, stat: vi.fn(actual.stat) }
})

const ZERO_HASH = '0'.repeat(64)
const runId = 'run-20261104-000001'

const logEvent = (message: string) => ({
  type: 'log' as const,
  actor: { type: 'system' as const, id: 'test' },
  data: { level: 'info' as const, message },
})

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

describe('FsEventStore', () => {
  let root: string
  let taktDir: string
  let store: FsEventStore

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'takt-store-ev-'))
    taktDir = path.join(root, '.takt')
    store = new FsEventStore(taktDir)
  })

  afterEach(async () => {
    vi.useRealTimers()
    vi.mocked(stat).mockReset()
    vi.mocked(stat).mockImplementation((await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')).stat)
    await rm(root, { recursive: true, force: true })
  })

  it('追加 50 条后哈希链校验通过', async () => {
    for (let i = 1; i <= 50; i++) await store.append(runId, logEvent(`e${i}`))
    const events = await store.read(runId)
    expect(events).toHaveLength(50)
    expect(events.map((e) => e.seq)).toEqual(Array.from({ length: 50 }, (_, i) => i + 1))
    expect(events[0]?.prevHash).toBe(ZERO_HASH)
    for (let i = 1; i < events.length; i++) expect(events[i]?.prevHash).toBe(events[i - 1]?.hash)
    expect(await store.verify(runId)).toEqual({ ok: true })
  })

  it('read 支持 afterSeq / nodeId / types 过滤', async () => {
    for (let i = 1; i <= 5; i++) await store.append(runId, logEvent(`e${i}`))
    for (let i = 1; i <= 3; i++) await store.append(runId, { ...logEvent(`n${i}`), nodeId: 'node-a' })
    await store.append(runId, {
      type: 'node.started',
      actor: { type: 'agent', role: 'dev', harness: 'codex' },
      nodeId: 'node-a',
      data: { attempt: 1 },
    })

    expect((await store.read(runId, { afterSeq: 7 })).map((e) => e.seq)).toEqual([8, 9])
    expect(await store.read(runId, { nodeId: 'node-a' })).toHaveLength(4)
    expect(await store.read(runId, { types: ['node.started'] })).toHaveLength(1)
    expect(await store.read(runId, { types: [] })).toHaveLength(9)
    expect(await store.read('run-20261104-999999')).toEqual([])
  })

  it('篡改中间一行 data 后 verify 返回该 seq', async () => {
    for (let i = 1; i <= 50; i++) await store.append(runId, logEvent(`e${i}`))
    const file = eventsFile(taktDir, runId)
    const lines = (await readFile(file, 'utf8')).split('\n').filter((line) => line !== '')
    lines[24] = JSON.stringify({ ...(JSON.parse(lines[24]!) as EventEnvelope), data: { level: 'warn', message: 'tampered' } })
    await writeFile(file, `${lines.join('\n')}\n`)
    expect(await store.verify(runId)).toEqual({ ok: false, brokenAt: 25 })
  })

  it('损坏行（非法 JSON）也报它应有的 seq', async () => {
    for (let i = 1; i <= 20; i++) await store.append(runId, logEvent(`e${i}`))
    const file = eventsFile(taktDir, runId)
    const lines = (await readFile(file, 'utf8')).split('\n').filter((line) => line !== '')
    lines[9] = '{ 这不是 JSON'
    await writeFile(file, `${lines.join('\n')}\n`)
    expect(await store.verify(runId)).toEqual({ ok: false, brokenAt: 10 })
    expect(await store.verify('run-20261104-000404')).toEqual({ ok: true })
  })

  it('并发追加（两个实例）seq 连续且校验通过', async () => {
    const other = new FsEventStore(taktDir)
    await Promise.all([
      ...Array.from({ length: 10 }, (_, i) => store.append(runId, logEvent(`a${i}`))),
      ...Array.from({ length: 10 }, (_, i) => other.append(runId, logEvent(`b${i}`))),
    ])
    expect((await store.read(runId)).map((e) => e.seq)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1))
    expect(await other.verify(runId)).toEqual({ ok: true })
  })

  it('subscribe 能收到另一个实例追加的事件，取消后不再收到', async () => {
    const writer = new FsEventStore(taktDir)
    const received: EventEnvelope[] = []
    const unsubscribe = store.subscribe(runId, (e) => received.push(e))
    await writer.append(runId, logEvent('hello'))
    await wait(800)
    expect(received.map((e) => (e.data as { message: string }).message)).toEqual(['hello'])
    unsubscribe()
    await writer.append(runId, logEvent('after-unsubscribe'))
    await wait(500)
    expect(received).toHaveLength(1)
  })

  it('订阅能处理半行和跨块的多字节字符', async () => {
    const partialRun = 'run-20261104-000009'
    const received: EventEnvelope[] = []
    const unsubscribe = store.subscribe(partialRun, (e) => received.push(e))
    const line =
      `${JSON.stringify({
        seq: 1,
        ts: new Date().toISOString(),
        runId: partialRun,
        type: 'log',
        actor: { type: 'system', id: 'test' },
        data: { level: 'info', message: '你好世界' },
        prevHash: ZERO_HASH,
        hash: 'x',
      })}\n`
    const bytes = Buffer.from(line, 'utf8')
    const splitAt = bytes.indexOf(Buffer.from('世')) + 1
    const file = eventsFile(taktDir, partialRun)
    await mkdir(path.dirname(file), { recursive: true })
    await appendFile(file, bytes.subarray(0, splitAt))
    await wait(450)
    await appendFile(file, bytes.subarray(splitAt))
    await wait(450)
    unsubscribe()
    expect(received).toHaveLength(1)
    expect((received[0]?.data as { message?: string } | undefined)?.message).toBe('你好世界')
  })

  it.each([null, false, 7, 'text', [], {}, { seq: 2, actor: null }])('不合法信封 %j 返回首个坏序号', async (invalid) => {
    await store.append(runId, logEvent('valid'))
    await appendFile(eventsFile(taktDir, runId), `${JSON.stringify(invalid)}\n`)
    expect(await store.verify(runId)).toEqual({ ok: false, brokenAt: 2 })
  })

  it('即使重算哈希也拒绝错误 runId 和不合法字段', async () => {
    const envelope = await store.append(runId, logEvent('original'))
    for (const patch of [{ runId: 'another-run' }, { ts: 123 }, { actor: {} }, { data: null }, { type: 'unknown' }, { nodeId: [] }]) {
      const { hash: _hash, prevHash, ...payload } = { ...envelope, ...patch }
      const invalid = { ...payload, prevHash, hash: sha256(prevHash + canonicalJson(payload)) }
      await writeFile(eventsFile(taktDir, runId), `${JSON.stringify(invalid)}\n`)
      expect(await store.verify(runId)).toEqual({ ok: false, brokenAt: 1 })
    }
  })

  it('相对路径实例和绝对路径实例追加共享同一队列', async () => {
    const other = new FsEventStore(path.relative(process.cwd(), taktDir))
    await Promise.all(Array.from({ length: 20 }, (_, i) => (i % 2 ? store : other).append(runId, logEvent(`${i}`))))
    expect((await store.read(runId)).map((e) => e.seq)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1))
    expect(await store.verify(runId)).toEqual({ ok: true })
  })

  it('异步轮询进行中取消订阅不会继续回调', async () => {
    vi.useFakeTimers()
    const received: EventEnvelope[] = []
    const unsubscribe = store.subscribe(runId, (event) => received.push(event))
    await store.append(runId, logEvent('delayed'))
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
    let release!: () => void
    const blocked = new Promise<void>((resolve) => { release = resolve })
    let started!: () => void
    const polling = new Promise<void>((resolve) => { started = resolve })
    vi.mocked(stat).mockImplementationOnce(async () => {
      started()
      await blocked
      return actual.stat(eventsFile(taktDir, runId))
    })
    try {
      await vi.advanceTimersByTimeAsync(300)
      await polling
      unsubscribe()
      release()
      // poll 在 stat 之后仍要完成真实文件读；等其关闭句柄后再断言。
      vi.useRealTimers()
      await wait(100)
      expect(received).toEqual([])
    } finally {
      release()
      unsubscribe()
    }
  })

  it('回调内取消时同一批次的剩余事件不再送达', async () => {
    const received: EventEnvelope[] = []
    const unsubscribe = store.subscribe(runId, (event) => { received.push(event); unsubscribe() })
    try {
      await store.append(runId, logEvent('first'))
      await store.append(runId, logEvent('second'))
      await wait(450)
      expect(received.map((e) => e.seq)).toEqual([1])
    } finally {
      unsubscribe()
    }
  })
  it('外部追加刷新缓存，截断和替换重新读取尾部，损坏尾部拒绝追加', async () => {
    const first = await store.append(runId, logEvent('first'))
    const second = { ...first, seq: 2, prevHash: first.hash, data: { level: 'info', message: 'external' } }
    const { hash: _hash, prevHash, ...payload } = second
    second.hash = sha256(prevHash + canonicalJson(payload))
    const file = eventsFile(taktDir, runId)
    await appendFile(file, `${JSON.stringify(second)}\n`)
    expect((await store.append(runId, logEvent('third'))).seq).toBe(3)
    expect(await store.verify(runId)).toEqual({ ok: true })
    await writeFile(file, `${JSON.stringify(first)}\n`)
    expect((await store.append(runId, logEvent('after-truncate'))).seq).toBe(2)
    expect(await store.verify(runId)).toEqual({ ok: true })
    await appendFile(file, '{unfinished')
    await expect(store.append(runId, logEvent('blocked'))).rejects.toThrow('换行')
    await writeFile(file, `${JSON.stringify({ ...first, hash: 'a'.repeat(64) })}\n`)
    await expect(store.append(runId, logEvent('blocked'))).rejects.toThrow('损坏')
  })

  it('同大小替换与截断后重写更长的有效链会重建缓存，非法追加不写入', async () => {
    const first = await store.append(runId, logEvent('original'))
    await store.append(runId, logEvent('second'))
    const file = eventsFile(taktDir, runId)
    const make = (seq: number, prevHash: string, message: string) => {
      const payload = { seq, ts: first.ts, runId, ...logEvent(message) }
      return { ...payload, prevHash, hash: sha256(prevHash + canonicalJson(payload)) }
    }
    const replacement = make(1, ZERO_HASH, 'new-first-' + 'x'.repeat(2000))
    const next = make(2, replacement.hash, 'new-second')
    await writeFile(file, `${JSON.stringify(replacement)}\n${JSON.stringify(next)}\n`)
    expect((await store.append(runId, logEvent('after-rewrite'))).seq).toBe(3)
    expect(await store.verify(runId)).toEqual({ ok: true })
    const lines = (await readFile(file, 'utf8')).trim().split('\n')
    const last = JSON.parse(lines.at(-1)!) as EventEnvelope
    const sameSize = { ...last, data: { level: 'info', message: 'equal-rewrite' } }
    const { hash: _hash, prevHash, ...payload } = sameSize
    sameSize.hash = sha256(prevHash + canonicalJson(payload))
    lines[lines.length - 1] = JSON.stringify(sameSize)
    const oldSize = (await stat(file)).size
    await writeFile(file, `${lines.join('\n')}\n`)
    expect((await stat(file)).size).toBe(oldSize)
    expect((await store.append(runId, logEvent('after-same-size'))).seq).toBe(4)
    expect(await store.verify(runId)).toEqual({ ok: true })
    await appendFile(file, `${JSON.stringify(make(5, ZERO_HASH, 'bad-link'))}\n`)
    const before = await readFile(file, 'utf8')
    await expect(store.append(runId, logEvent('must-not-write'))).rejects.toThrow('断链')
    expect(await readFile(file, 'utf8')).toBe(before)
  })

  it('增量读取保留过滤语义，旧游标回读不影响后续增量读取', async () => {
    await store.append(runId, logEvent('一'))
    expect(await store.read(runId, { afterSeq: 0 })).toHaveLength(1)
    await store.append(runId, { ...logEvent('二'), nodeId: 'a' })
    await store.append(runId, { ...logEvent('三'), nodeId: 'b' })
    expect((await store.read(runId, { afterSeq: 1, nodeId: 'b', types: ['log'] })).map(e => e.seq)).toEqual([3])
    expect((await store.read(runId, { afterSeq: 1 })).map(e => e.seq)).toEqual([2, 3])
    expect(await store.read(runId, { afterSeq: 3 })).toEqual([])
    await store.append(runId, logEvent('四'))
    expect((await store.read(runId, { afterSeq: 3 })).map(e => e.seq)).toEqual([4])
  })

  it('增量读取等待完整换行，保留跨块 UTF-8，报错保持完整文件行号', async () => {
    const first = await store.append(runId, logEvent('一'))
    await store.read(runId)
    const file = eventsFile(taktDir, runId)
    const bytes = Buffer.from(JSON.stringify({ ...first, seq: 2, data: { message: '你'.repeat(30000) } }) + '\n')
    const cut = bytes.indexOf(Buffer.from('你')) + 1
    await appendFile(file, bytes.subarray(0, cut))
    expect(await store.read(runId, { afterSeq: 1 })).toEqual([])
    await appendFile(file, bytes.subarray(cut, -1))
    expect(await store.read(runId, { afterSeq: 1 })).toEqual([])
    await appendFile(file, '\n')
    const events = await store.read(runId, { afterSeq: 1 })
    expect(events).toHaveLength(1)
    expect(events[0]!.data).toEqual({ message: '你'.repeat(30000) })
    await appendFile(file, '\n{bad}\n')
    await expect(store.read(runId, { afterSeq: 2 })).rejects.toThrow(`事件日志第 4 行不是合法事件：${file}`)
  })

  it('读取缓存遇到替换或截断失效，同大小原地重写也重新校验', async () => {
    const first = await store.append(runId, logEvent('first'))
    await store.append(runId, logEvent('second'))
    await store.read(runId)
    const file = eventsFile(taktDir, runId)
    const replacement = JSON.stringify({ ...first, seq: 10 }) + '\n'
    await writeFile(file + '.new', replacement)
    await rename(file + '.new', file)
    expect((await store.read(runId, { afterSeq: 2 })).map(e => e.seq)).toEqual([10])
    await writeFile(file, '')
    expect(await store.read(runId, { afterSeq: 10 })).toEqual([])
    await appendFile(file, JSON.stringify({ ...first, seq: 11 }) + '\n')
    expect((await store.read(runId, { afterSeq: 10 })).map(e => e.seq)).toEqual([11])
    await writeFile(file, JSON.stringify({ ...first, seq: 12 }) + '\n')
    expect((await store.read(runId, { afterSeq: 11 })).map(e => e.seq)).toEqual([12])
  })

  it('5 万行热缓存连续 100 次尾部补读不重解析，累计小于 1 秒', async () => {
    const first = await store.append(runId, logEvent('大文件'))
    const file = eventsFile(taktDir, runId)
    await writeFile(file, Array.from({ length: 50000 }, (_, i) => JSON.stringify({ ...first, seq: i + 1 })).join('\n') + '\n')
    expect(await store.read(runId)).toHaveLength(50000)
    const parse = vi.spyOn(JSON, 'parse')
    try {
      const began = performance.now()
      for (let i = 0; i < 100; i++) expect(await store.read(runId, { afterSeq: 50000 })).toEqual([])
      expect(performance.now() - began).toBeLessThan(1000)
      expect(parse).not.toHaveBeenCalled()
    } finally { parse.mockRestore() }
  })


  it('旧版 claude-code 逐 token 记下的 thinking 事件读取时跳过，游标和哈希链校验不受影响', async () => {
    const thinking = (n: number) => ({
      type: 'harness.message' as const,
      actor: { type: 'agent' as const, role: 'pm', harness: 'claude-code' },
      data: { role: 'system' as const, text: JSON.stringify({ type: 'system', subtype: 'thinking_tokens', estimated_tokens: n, estimated_tokens_delta: 1 }) },
    })
    await store.append(runId, logEvent('开始'))
    for (let n = 1; n <= 1500; n++) await store.append(runId, thinking(n))
    // 真实事件里提到 thinking_tokens（比如 Agent 自己说的话）不能被误跳过
    await store.append(runId, { ...thinking(0), data: { role: 'assistant' as const, text: '{"type":"system","subtype":"thinking_tokens"}' } })
    await store.append(runId, logEvent('结束'))
    const all = await store.read(runId)
    expect(all.map((e) => e.seq)).toEqual([1, 1502, 1503])
    expect((await store.read(runId, { afterSeq: 1200 })).map((e) => e.seq)).toEqual([1502, 1503])
    expect((await new FsEventStore(taktDir).read(runId, { afterSeq: 1 })).map((e) => e.seq)).toEqual([1502, 1503])
    expect(await store.verify(runId)).toEqual({ ok: true })
  })
})
