import { realpath } from 'node:fs/promises'
import path from 'node:path'
import {
  acquireLease,
  releaseLease,
  renewLease,
  withLock,
  type Lease,
  type ProjectStores,
} from '@taktflow/core'
import { UsageError } from './args.js'

/** 空间被别人持有时抛出的错误；serve 会把它映射成 HTTP 409。 */
export class LeaseHeldError extends Error {
  readonly code = 'TAKT_LEASE_HELD'
  constructor(readonly held: Lease, readonly stale: boolean) {
    super(`空间正被 ${held.owner} 使用（自 ${held.acquiredAt}）`)
    this.name = 'LeaseHeldError'
  }
}

export interface LeaseOptions {
  takeover?: boolean
  ttlMs?: number
  /** 仅测试用：缩短续约间隔。 */
  heartbeatMs?: number
  /** 续约失败时取消在途任务；错误不能吞掉，最终由 withLease 抛出。 */
  onRenewError?: (error: unknown) => void | Promise<void>
}

interface Observer {
  controller: AbortController
  onRenewError?: (error: unknown) => void | Promise<void>
}

interface Held {
  lease: Lease
  refs: number
  timer?: NodeJS.Timeout
  renewal?: Promise<void>
  error?: unknown
  renewing: boolean
  /** 每个并发 withLease 各登记一份，续约失败时要全部取消，不能只留首个。 */
  observers: Set<Observer>
}

const held = new Map<string, Held>()

const messageOf = (error: unknown): string => error instanceof Error ? error.message : String(error)

/** symlink 别名必须落到同一个引用计数和同一个进程内队列。 */
async function canonicalDir(taktDir: string): Promise<string> {
  try {
    return await realpath(taktDir)
  } catch {
    return path.resolve(taktDir)
  }
}

const keyOf = async (taktDir: string, owner: string): Promise<string> => `${await canonicalDir(taktDir)}\0${owner}`

/** 续约失败时先同步 abort 所有任务，再逐个等待取消；任何一个取消失败都要并进最终错误。 */
async function failObservers(entry: Held, error: unknown): Promise<void> {
  const observers = [...entry.observers]
  for (const observer of observers) observer.controller.abort(error)
  const failures: string[] = []
  const results = await Promise.allSettled(observers.map(async (observer) => {
    await observer.onRenewError?.(error)
  }))
  for (const result of results) {
    if (result.status === 'rejected') failures.push(messageOf(result.reason))
  }
  if (failures.length > 0) {
    entry.error = new Error(
      `租约续约失败：${messageOf(error)}；取消在途任务失败：${failures.join('；')}`,
      { cause: error },
    )
  }
}

function startHeartbeat(taktDir: string, owner: string, entry: Held, intervalMs: number): void {
  const tick = (): void => {
    if (entry.renewing || entry.error !== undefined) return
    entry.renewing = true
    const task = (async () => {
      try {
        entry.lease = await renewLease(taktDir, owner)
      } catch (error) {
        entry.error = error
        if (entry.timer) {
          clearInterval(entry.timer)
          entry.timer = undefined
        }
        await failObservers(entry, error)
      } finally {
        entry.renewing = false
      }
    })()
    entry.renewal = task
    void task.finally(() => {
      if (entry.renewal === task) entry.renewal = undefined
    })
  }
  const timer = setInterval(tick, intervalMs)
  timer.unref()
  entry.timer = timer
}

/**
 * 最后一次引用释放时必须整个"等在途续约 → 删除租约文件 → 删除进程内条目"都在锁内完成。
 * 否则新的 acquire 可能先拿到同一 owner 的租约，又被旧的 finally 释放掉。
 */
async function releaseHeld(key: string, taktDir: string, owner: string, entry: Held, observer: Observer): Promise<void> {
  await withLock(key, async () => {
    entry.observers.delete(observer)
    entry.refs -= 1
    if (entry.refs > 0) {
      // 任务完成时仍有续约在途：等它落定，调用方才能根据 entry.error 判断是否成功。
      await entry.renewal
      return
    }
    if (entry.timer) {
      clearInterval(entry.timer)
      entry.timer = undefined
    }
    try {
      await entry.renewal
      await releaseLease(taktDir, owner)
    } finally {
      held.delete(key)
    }
  })
}

/**
 * 在空间租约内执行任务。同进程同 owner 的并发调用引用计数，
 * 任意一个先结束都不会提前释放另一个仍在使用的租约。
 */
export async function withLease<T>(
  taktDir: string,
  owner: string,
  task: (signal: AbortSignal) => Promise<T>,
  options: LeaseOptions = {},
): Promise<T> {
  const key = await keyOf(taktDir, owner)
  const observer: Observer = {
    controller: new AbortController(),
    ...(options.onRenewError === undefined ? {} : { onRenewError: options.onRenewError }),
  }
  const entry = await withLock(key, async (): Promise<Held> => {
    const existing = held.get(key)
    if (existing) {
      // 已经续约失败的租约不允许再开始新任务。
      if (existing.error !== undefined) throw existing.error
      existing.refs += 1
      existing.observers.add(observer)
      return existing
    }
    const result = await acquireLease(taktDir, owner, {
      ...(options.ttlMs === undefined ? {} : { ttlMs: options.ttlMs }),
      ...(options.takeover === undefined ? {} : { takeover: options.takeover }),
    })
    if (!result.ok) throw new LeaseHeldError(result.held, result.stale)
    const created: Held = {
      lease: result.lease,
      refs: 1,
      renewing: false,
      observers: new Set([observer]),
    }
    held.set(key, created)
    startHeartbeat(taktDir, owner, created, options.heartbeatMs ?? 10_000)
    return created
  })
  if (entry.error !== undefined) {
    try { await releaseHeld(key, taktDir, owner, entry, observer) } catch { /* 已续约失败，优先抛原始错误 */ }
    throw entry.error
  }
  let outcome: { ok: true; value: T } | { ok: false; error: unknown }
  try {
    outcome = { ok: true, value: await task(observer.controller.signal) }
  } catch (error) {
    outcome = { ok: false, error }
  }
  let releaseError: unknown
  try {
    await releaseHeld(key, taktDir, owner, entry, observer)
  } catch (error) {
    releaseError = error
  }
  // releaseHeld 可能刚刚等到在途续约失败，必须在返回成功前重新检查。
  const renewalError = entry.error
  if (renewalError !== undefined) {
    const suffix = `租约续约失败：${messageOf(renewalError)}`
    if (!outcome.ok) throw new Error(`${messageOf(outcome.error)}；${suffix}`, { cause: outcome.error })
    if (releaseError !== undefined) {
      throw new Error(`${suffix}；释放空间租约失败：${messageOf(releaseError)}`, { cause: renewalError })
    }
    throw renewalError
  }
  if (!outcome.ok) {
    if (releaseError !== undefined) process.stderr.write(`释放空间租约失败：${messageOf(releaseError)}\n`)
    throw outcome.error
  }
  if (releaseError !== undefined) throw releaseError
  return outcome.value
}

export const cliLeaseOwner = (): string => `cli:${process.pid}`

/** CLI 写命令：租约被别人持有或失效时转成参数错误，并给出下一步提示。 */
export async function withCliLease<T>(
  taktDir: string,
  task: (signal: AbortSignal) => Promise<T>,
  options: LeaseOptions = {},
): Promise<T> {
  try {
    return await withLease(taktDir, cliLeaseOwner(), task, options)
  } catch (error) {
    if (error instanceof LeaseHeldError) {
      throw new UsageError(`${error.message}。${error.stale
        ? '租约已失效，确认没有其它进程在运行后，加 --takeover 显式接管。'
        : '请在 dsh 里操作，或在 dsh 主面板释放空间后重试。'}`)
    }
    throw error
  }
}

export interface WriteLeaseHook {
  <T>(stores: ProjectStores, fn: () => Promise<T>): Promise<T>
}

/** serve 的每次写操作（含答复后的恢复）短暂持有 serve:<pid> 租约。 */
export function createWriteLeaseHook(options: LeaseOptions = {}): WriteLeaseHook {
  return (stores, fn) => withLease(stores.taktDir, `serve:${process.pid}`, () => fn(), options)
}

export interface Interrupts {
  readonly interrupted: boolean
  /** 等待信号触发的取消完成；调用方必须在释放租约前 await。 */
  drain(): Promise<void>
  dispose(): void
}

/** Ctrl-C / SIGTERM 先触发取消，等任务收敛后由调用方释放租约；不在信号处理里直接退出。 */
export function handleInterrupts(onInterrupt: () => void | Promise<void>): Interrupts {
  let interrupted = false
  let pending: Promise<void> | undefined
  let failure: unknown
  let failed = false
  const handler = (): void => {
    if (interrupted) return
    interrupted = true
    pending = Promise.resolve().then(onInterrupt).catch((error: unknown) => {
      // 先记录再写 stderr；drain 必须把取消失败重抛给业务调用方。
      failure = error
      failed = true
      process.stderr.write(`取消运行失败：${messageOf(error)}\n`)
    })
  }
  process.on('SIGINT', handler)
  process.on('SIGTERM', handler)
  return {
    get interrupted() { return interrupted },
    async drain() {
      await pending
      if (failed) throw failure
    },
    dispose() {
      process.off('SIGINT', handler)
      process.off('SIGTERM', handler)
    },
  }
}
