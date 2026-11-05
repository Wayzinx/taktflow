import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { hostname, tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { readLease, type Engine, type ProjectStores } from '@taktflow/core'
import { createWriteLeaseHook, LeaseHeldError, withCliLease, withLease } from './lease.js'
import { ActiveRun, runWithDrain } from './commands/run.js'

const gate = vi.hoisted(() => {
  const deferred = () => {
    let resolve!: () => void
    const promise = new Promise<void>((done) => { resolve = done })
    return { promise, resolve }
  }
  return {
    gateRelease: false,
    renewFail: false,
    releaseStarted: deferred(),
    releaseRelease: deferred(),
    renewStarted: deferred(),
    renewRelease: deferred(),
    reset() {
      this.gateRelease = false
      this.renewFail = false
      this.releaseStarted = deferred()
      this.releaseRelease = deferred()
      this.renewStarted = deferred()
      this.renewRelease = deferred()
    },
  }
})

vi.mock('@taktflow/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@taktflow/core')>()
  return {
    ...actual,
    releaseLease: async (taktDir: string, owner: string) => {
      if (!gate.gateRelease) return actual.releaseLease(taktDir, owner)
      gate.gateRelease = false
      gate.releaseStarted.resolve()
      await gate.releaseRelease.promise
      await actual.releaseLease(taktDir, owner)
    },
    renewLease: async (taktDir: string, owner: string, opts?: { now?: () => Date }) => {
      if (!gate.renewFail) return actual.renewLease(taktDir, owner, opts)
      gate.renewStarted.resolve()
      await gate.renewRelease.promise
      throw new Error('续约失败（测试注入）')
    },
  }
})

const roots: string[] = []
beforeEach(() => gate.reset())
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function taktDir(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'takt-cli-lease-'))
  roots.push(root)
  const dir = path.join(root, '.takt')
  await mkdir(dir, { recursive: true })
  return dir
}

async function writeLease(dir: string, lease: Record<string, unknown>): Promise<void> {
  await writeFile(path.join(dir, 'lease.json'), JSON.stringify({
    owner: 'other',
    pid: process.pid,
    host: hostname(),
    acquiredAt: '2020-01-01T00:00:00.000Z',
    heartbeatAt: '2020-01-01T00:00:00.000Z',
    ttlMs: 60_000,
    ...lease,
  }))
}

async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ['-e', ''])
  const pid = child.pid!
  await once(child, 'exit')
  return pid
}

it('最后一个引用释放期间新的 withLease 不能插入，租约不会被旧的 finally 删掉', async () => {
  const dir = await taktDir()
  gate.gateRelease = true
  const first = withLease(dir, 'cli:1', async () => undefined)
  await gate.releaseStarted.promise
  let observed: unknown
  const second = withLease(dir, 'cli:1', async () => {
    await gate.releaseRelease.promise
    observed = await readLease(dir)
  })
  await new Promise((resolve) => setTimeout(resolve, 50))
  gate.releaseRelease.resolve()
  await Promise.all([first, second])
  expect(observed).toBeDefined()
  expect(await readLease(dir)).toBeUndefined()
})

it('symlink 别名与真实路径共用同一引用计数', async () => {
  const dir = await taktDir()
  const alias = `${dir}-alias`
  await symlink(dir, alias, 'dir')
  let releaseFirst!: () => void
  const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve })
  let firstStarted!: () => void
  const started = new Promise<void>((resolve) => { firstStarted = resolve })
  const first = withLease(dir, 'cli:1', async () => {
    firstStarted()
    await firstGate
  })
  await started
  let releaseSecond!: () => void
  const secondGate = new Promise<void>((resolve) => { releaseSecond = resolve })
  const second = withLease(alias, 'cli:1', async () => {
    await secondGate
  })
  await new Promise((resolve) => setTimeout(resolve, 30))
  releaseFirst()
  await first
  expect(await readLease(dir)).toBeDefined()
  releaseSecond()
  await second
  expect(await readLease(dir)).toBeUndefined()
})

it('serve 钩子并发写不会释放仍在执行者的租约', async () => {
  const dir = await taktDir()
  const hook = createWriteLeaseHook()
  const stores = { taktDir: dir } as ProjectStores
  let release!: () => void
  const slowGate = new Promise<void>((resolve) => { release = resolve })
  let entered!: () => void
  const started = new Promise<void>((resolve) => { entered = resolve })
  const slow = hook(stores, async () => {
    entered()
    await slowGate
    expect(await readLease(dir)).toBeDefined()
  })
  await started
  await hook(stores, async () => undefined)
  expect(await readLease(dir)).toBeDefined()
  release()
  await slow
  expect(await readLease(dir)).toBeUndefined()
})

it('空间被占用时给出 dsh 提示；失效租约提示 --takeover', async () => {
  const dir = await taktDir()
  await writeLease(dir, { owner: 'serve:42' })
  const held = withCliLease(dir, async () => undefined)
  await expect(held).rejects.toThrow('空间正被 serve:42 使用（自 2020-01-01T00:00:00.000Z）。请在 dsh 里操作，或在 dsh 主面板释放空间后重试。')
  await expect(held).rejects.toBeInstanceOf(Error)

  await writeLease(dir, { owner: 'serve:42', pid: await deadPid(), heartbeatAt: '2020-01-01T00:00:00.000Z', ttlMs: 1 })
  await expect(withCliLease(dir, async () => undefined)).rejects.toThrow('加 --takeover 显式接管')
  expect(await withCliLease(dir, async () => 'taken', { takeover: true })).toBe('taken')
  expect(await readLease(dir)).toBeUndefined()
})

it('续约失败会取消在途任务并抛出错误', async () => {
  const dir = await taktDir()
  gate.renewFail = true
  let cancelled = false
  let release!: () => void
  const taskDone = new Promise<void>((resolve) => { release = resolve })
  const running = withLease(dir, 'cli:1', async () => {
    await taskDone
  }, {
    heartbeatMs: 10,
    onRenewError: () => {
      cancelled = true
      release()
    },
  })
  try {
    await gate.renewStarted.promise
    gate.renewRelease.resolve()
    await expect(running).rejects.toThrow('续约失败（测试注入）')
    expect(cancelled).toBe(true)
  } finally {
    release()
    await running.catch(() => undefined)
  }
})

it('续约失败会取消所有并发任务，而不是只取消首个', async () => {
  const dir = await taktDir()
  const cancelled: string[] = []
  let releaseA!: () => void
  let releaseB!: () => void
  const aDone = new Promise<void>((resolve) => { releaseA = resolve })
  const bDone = new Promise<void>((resolve) => { releaseB = resolve })
  const signals: AbortSignal[] = []
  const a = withLease(dir, 'cli:1', async (signal) => {
    signals.push(signal)
    await aDone
  }, { heartbeatMs: 10, onRenewError: () => { cancelled.push('a'); releaseA() } })
  const b = withLease(dir, 'cli:1', async (signal) => {
    signals.push(signal)
    await bDone
  }, { heartbeatMs: 10, onRenewError: () => { cancelled.push('b'); releaseB() } })
  // 立即观察两个 Promise：续约失败时可能同时拒绝，晚注册 expect 会漏成 unhandled。
  const settled = Promise.allSettled([a, b])
  try {
    await vi.waitFor(() => expect(signals).toHaveLength(2))
    // 两个观察者都登记后再让下一次续约失败。
    gate.renewFail = true
    await gate.renewStarted.promise
    gate.renewRelease.resolve()
    const results = await settled
    expect(results.map((result) => result.status)).toEqual(['rejected', 'rejected'])
    for (const result of results) {
      if (result.status === 'rejected') {
        expect(result.reason).toBeInstanceOf(Error)
        expect((result.reason as Error).message).toContain('续约失败（测试注入）')
      }
    }
    expect(cancelled.sort()).toEqual(['a', 'b'])
    expect(signals.every((signal) => signal.aborted)).toBe(true)
  } finally {
    releaseA()
    releaseB()
    await Promise.allSettled([a, b])
  }
})

it('续约失败后同一租约不会开始新任务', async () => {
  const dir = await taktDir()
  gate.renewFail = true
  let releaseA!: () => void
  const aDone = new Promise<void>((resolve) => { releaseA = resolve })
  let aStarted!: () => void
  const aReady = new Promise<void>((resolve) => { aStarted = resolve })
  let failed!: () => void
  const renewalFailed = new Promise<void>((resolve) => { failed = resolve })
  const a = withLease(dir, 'cli:1', async () => {
    aStarted()
    await aDone
  }, { heartbeatMs: 10, onRenewError: () => { failed() } })
  try {
    await aReady
    await gate.renewStarted.promise
    gate.renewRelease.resolve()
    await renewalFailed
    let started = false
    await expect(withLease(dir, 'cli:1', async () => { started = true })).rejects.toThrow('续约失败（测试注入）')
    expect(started).toBe(false)
  } finally {
    releaseA()
    await a.catch(() => undefined)
  }
})

it('任务完成时仍有续约在途，失败不能被当成成功返回', async () => {
  const dir = await taktDir()
  gate.renewFail = true
  const running = withLease(dir, 'cli:1', async () => {
    await gate.renewStarted.promise
    return 'ok'
  }, { heartbeatMs: 5 })
  let settled = false
  void running.then(() => { settled = true }, () => { settled = true })
  await new Promise((resolve) => setTimeout(resolve, 30))
  // 任务已返回，但 releaseHeld 还在等在途续约。
  expect(settled).toBe(false)
  gate.renewRelease.resolve()
  await expect(running).rejects.toThrow('续约失败（测试注入）')
})

it('取消在途任务失败时错误会合并而不是吞掉', async () => {
  const dir = await taktDir()
  gate.renewFail = true
  let release!: () => void
  const taskDone = new Promise<void>((resolve) => { release = resolve })
  const running = withLease(dir, 'cli:1', async () => {
    await taskDone
  }, {
    heartbeatMs: 10,
    onRenewError: () => {
      release()
      throw new Error('取消失败')
    },
  })
  try {
    await gate.renewStarted.promise
    gate.renewRelease.resolve()
    await expect(running).rejects.toThrow('取消在途任务失败：取消失败')
  } finally {
    release()
    await running.catch(() => undefined)
  }
})

it('提前取消在 settle 后只触发一次 engine.cancel，drain 等它结束', async () => {
  const active = new ActiveRun()
  let calls = 0
  let release!: () => void
  const cancelGate = new Promise<void>((resolve) => { release = resolve })
  const engine = {
    cancel: async () => {
      calls += 1
      await cancelGate
    },
  } as unknown as Engine
  await active.cancel()
  expect(active.cancelled).toBe(true)
  const settling = active.settle(engine, 'run-1')
  const cancelling = active.cancel()
  await new Promise((resolve) => setTimeout(resolve, 10))
  expect(calls).toBe(1)
  release()
  await Promise.all([settling, cancelling, active.drain()])
  expect(calls).toBe(1)
})

it('取消的异步写入完成后才释放租约', async () => {
  const dir = await taktDir()
  const active = new ActiveRun()
  let finishCancel!: () => void
  const cancelGate = new Promise<void>((resolve) => { finishCancel = resolve })
  let cancelStarted!: () => void
  const started = new Promise<void>((resolve) => { cancelStarted = resolve })
  const engine = {
    cancel: async () => {
      cancelStarted()
      await cancelGate
    },
  } as unknown as Engine
  let settled = false
  const running = withCliLease(dir, async () => {
    await active.settle(engine, 'run-1')
    void active.cancel()
    await active.drain()
    return 'done'
  })
  void running.then(() => { settled = true }, () => { settled = true })
  await started
  expect(await readLease(dir)).toBeDefined()
  await new Promise((resolve) => setTimeout(resolve, 20))
  expect(settled).toBe(false)
  finishCancel()
  await expect(running).resolves.toBe('done')
  expect(await readLease(dir)).toBeUndefined()
})

it('LeaseHeldError 带 TAKT_LEASE_HELD 供 server 映射 409', async () => {
  const dir = await taktDir()
  await writeLease(dir, { owner: 'serve:42' })
  const error = await withLease(dir, 'cli:1', async () => undefined).catch((caught: unknown) => caught)
  expect(error).toBeInstanceOf(LeaseHeldError)
  expect((error as LeaseHeldError).code).toBe('TAKT_LEASE_HELD')
})

it('引擎任务抛错时仍等待取消写入，租约在取消结束前不释放', async () => {
  const dir = await taktDir()
  const active = new ActiveRun()
  let cancelStarted!: () => void
  const started = new Promise<void>((resolve) => { cancelStarted = resolve })
  let finishCancel!: () => void
  const cancelGate = new Promise<void>((resolve) => { finishCancel = resolve })
  const engine = {
    cancel: async () => {
      cancelStarted()
      await cancelGate
    },
  } as unknown as Engine
  const running = withCliLease(dir, () => runWithDrain(
    async () => {
      await active.settle(engine, 'run-1')
      void active.cancel()
      throw new Error('引擎失败')
    },
    () => active.drain(),
  ))
  const outcome = running.catch((error: unknown) => error)
  await started
  let settled = false
  void outcome.then(() => { settled = true })
  await new Promise((resolve) => setTimeout(resolve, 20))
  // 业务已失败，但取消写入还没结束：租约不能提前释放。
  expect(settled).toBe(false)
  expect(await readLease(dir)).toBeDefined()
  finishCancel()
  const error = await outcome
  expect(error).toBeInstanceOf(Error)
  expect((error as Error).message).toBe('引擎失败')
  expect(await readLease(dir)).toBeUndefined()
})

it('业务异常与取消失败同时发生时保留两段上下文', async () => {
  const error = await runWithDrain(
    async () => { throw new Error('引擎失败') },
    async () => { throw new Error('取消写入失败') },
  ).catch((caught: unknown) => caught)
  expect(error).toBeInstanceOf(Error)
  expect((error as Error).message).toBe('引擎失败；等待取消失败：取消写入失败')
  expect(((error as Error).cause as Error).message).toBe('引擎失败')
})

it('任务成功但取消写入失败时抛出取消失败', async () => {
  await expect(runWithDrain(async () => 'ok', async () => { throw new Error('取消写入失败') }))
    .rejects.toThrow('取消写入失败')
})
