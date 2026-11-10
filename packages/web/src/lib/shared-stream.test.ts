import { afterEach, beforeEach, expect, it, vi } from 'vitest'

/** 最小的 Web Locks：同名锁排队，回调返回的 Promise 结束才放锁；排队中可以 abort。 */
class FakeLocks {
  private held = new Set<string>()
  private queue = new Map<string, Array<() => void>>()
  request(name: string, opts: { signal?: AbortSignal }, cb: () => unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const run = () => {
        this.held.add(name)
        void Promise.resolve(cb()).then((r) => {
          this.held.delete(name)
          this.queue.get(name)?.shift()?.()
          resolve(r)
        })
      }
      if (!this.held.has(name)) return run()
      const q = this.queue.get(name) ?? []
      q.push(run)
      this.queue.set(name, q)
      opts.signal?.addEventListener('abort', () => {
        const i = q.indexOf(run)
        if (i < 0) return
        q.splice(i, 1)
        reject(new Error('AbortError'))
      })
    })
  }
}

/** 每个"标签页"是一份独立加载的模块（各自的 hub 表），共用同一个锁管理器和 BroadcastChannel。 */
const tab = async () => {
  vi.resetModules()
  return (await import('./shared-stream')).sharedStream
}
const tick = () => new Promise((r) => setTimeout(r, 20))

let conns: Array<{ emit: (v: unknown) => void; closed: boolean }>
const open = (emit: (v: unknown) => void) => {
  const c = { emit, closed: false }
  conns.push(c)
  return () => {
    c.closed = true
  }
}

beforeEach(() => {
  conns = []
  vi.stubGlobal('navigator', { locks: new FakeLocks() })
})
afterEach(() => vi.unstubAllGlobals())

it('两个标签订阅同一条流只连一次，消息两边都收到', async () => {
  const a = await tab()
  const b = await tab()
  const gotA: unknown[] = []
  const gotB: unknown[] = []
  const offA = a('feed', open, (v) => gotA.push(v))
  const offB = b('feed', open, (v) => gotB.push(v))
  await tick()
  expect(conns).toHaveLength(1)
  conns[0]!.emit({ n: 1 })
  await tick()
  expect(gotA).toEqual([{ n: 1 }])
  expect(gotB).toEqual([{ n: 1 }])
  offA()
  offB()
})

it('持有连接的标签退订后，另一个标签接手重连', async () => {
  const a = await tab()
  const b = await tab()
  const gotB: unknown[] = []
  const offA = a('feed', open, () => undefined)
  const offB = b('feed', open, (v) => gotB.push(v))
  await tick()
  offA()
  await tick()
  expect(conns).toHaveLength(2)
  expect(conns[0]!.closed).toBe(true)
  conns[1]!.emit('after-handover')
  await tick()
  expect(gotB).toEqual(['after-handover'])
  offB()
  expect(conns[1]!.closed).toBe(true)
})

it('同一标签里多个订阅者共用一条，最后一个退订才断开', async () => {
  const a = await tab()
  const got: unknown[] = []
  const off1 = a('thread', open, (v) => got.push(['1', v]))
  const off2 = a('thread', open, (v) => got.push(['2', v]))
  await tick()
  expect(conns).toHaveLength(1)
  conns[0]!.emit('x')
  expect(got).toEqual([['1', 'x'], ['2', 'x']])
  off1()
  expect(conns[0]!.closed).toBe(false)
  off2()
  expect(conns[0]!.closed).toBe(true)
})
