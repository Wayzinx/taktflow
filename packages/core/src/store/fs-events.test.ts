import { appendFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
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
})
