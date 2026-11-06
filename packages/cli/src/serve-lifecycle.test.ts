import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { readLease, type Engine, type ProjectStores } from '@taktflow/core'
import { createWriteLeaseHook, type WriteLeaseHook } from './lease.js'
import { ActiveRuns, ServeWrites, watchShutdown, type SignalTarget } from './commands/serve.js'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function taktDir(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'takt-serve-lifecycle-'))
  roots.push(root)
  const dir = path.join(root, '.takt')
  await mkdir(dir, { recursive: true })
  return dir
}

class FakeSignals implements SignalTarget {
  private readonly listeners = new Map<string, Set<() => void>>()

  on(signal: 'SIGINT' | 'SIGTERM', listener: () => void): this {
    const set = this.listeners.get(signal) ?? new Set()
    set.add(listener)
    this.listeners.set(signal, set)
    return this
  }

  off(signal: 'SIGINT' | 'SIGTERM', listener: () => void): this {
    this.listeners.get(signal)?.delete(listener)
    return this
  }

  emit(signal: 'SIGINT' | 'SIGTERM'): void {
    for (const listener of [...(this.listeners.get(signal) ?? [])]) listener()
  }

  count(): number {
    let total = 0
    for (const set of this.listeners.values()) total += set.size
    return total
  }
}

it('shutdown 后拒绝新写，已登记写释放租约前 stop 不返回', async () => {
  const dir = await taktDir()
  const writes = new ServeWrites(createWriteLeaseHook())
  const stores = { taktDir: dir } as ProjectStores
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  let entered!: () => void
  const started = new Promise<void>((resolve) => { entered = resolve })
  const write = writes.run(stores, async () => {
    entered()
    await gate
    expect(await readLease(dir)).toBeDefined()
  })
  await started
  const stopping = writes.stop()
  await expect(writes.run(stores, async () => undefined)).rejects.toThrow('服务正在关闭，拒绝新的写操作')
  let stopped = false
  void stopping.then(() => { stopped = true })
  await new Promise((resolve) => setTimeout(resolve, 20))
  // 原请求仍在执行：shutdown 必须等它完成并释放租约。
  expect(stopped).toBe(false)
  expect(await readLease(dir)).toBeDefined()
  release()
  await write
  await stopping
  expect(await readLease(dir)).toBeUndefined()
})

it('shutdown 落在 acquire 期间时，取得租约后不再执行业务', async () => {
  let releaseAcquire!: () => void
  const acquireGate = new Promise<void>((resolve) => { releaseAcquire = resolve })
  let entered!: () => void
  const acquired = new Promise<void>((resolve) => { entered = resolve })
  const hook: WriteLeaseHook = async (_stores, fn) => {
    entered()
    await acquireGate
    return fn()
  }
  const writes = new ServeWrites(hook)
  const stores = { taktDir: await taktDir() } as ProjectStores
  let executed = false
  const write = writes.run(stores, async () => { executed = true })
  await acquired
  const stopping = writes.stop()
  releaseAcquire()
  await expect(write).rejects.toThrow('服务正在关闭，拒绝新的写操作')
  await stopping
  expect(executed).toBe(false)
})

it('shutdown 后开始的 resume 在绑定引擎前标记取消', async () => {
  const runs = new ActiveRuns()
  await runs.stop()
  expect(runs.stopped).toBe(true)
  const active = runs.start()
  expect(active.cancelled).toBe(true)
  let calls = 0
  const engine = { cancel: async () => { calls += 1 } } as unknown as Engine
  await active.settle(engine, 'run-1')
  expect(calls).toBe(1)
  await active.drain()
  runs.finish(active)
})

it('清理期间监听器保持安装，重复信号只触发一次清理', async () => {
  const signals = new FakeSignals()
  let finish!: () => void
  const gate = new Promise<void>((resolve) => { finish = resolve })
  let calls = 0
  const shutdown = watchShutdown(async () => {
    calls += 1
    await gate
  }, signals)
  expect(signals.count()).toBe(2)
  signals.emit('SIGINT')
  signals.emit('SIGTERM')
  expect(calls).toBe(1)
  // 第二个信号不会绕过清理：监听器仍在，stop 仍未返回。
  expect(signals.count()).toBe(2)
  const stopping = shutdown.stop()
  let stopped = false
  void stopping.then(() => { stopped = true })
  await new Promise((resolve) => setTimeout(resolve, 20))
  expect(stopped).toBe(false)
  finish()
  await stopping
  expect(calls).toBe(1)
  shutdown.dispose()
  expect(signals.count()).toBe(0)
})
