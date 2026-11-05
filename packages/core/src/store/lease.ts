import { hostname } from 'node:os'
import { rm } from 'node:fs/promises'
import { readJsonFile, toJsonText, writeFileAtomic } from './fs-utils.js'
import { withFileLock } from './file-lock.js'
import { leaseFile } from './paths.js'

/** 空间租约：同一空间同一时刻只有一个执行者。 */
export interface Lease {
  owner: string
  pid: number
  host: string
  acquiredAt: string
  heartbeatAt: string
  ttlMs: number
}

export type LeaseResult =
  | { ok: true; lease: Lease }
  /** stale = 超过 TTL 且同 host 的 pid 已不存在；跨 host 只看 TTL。 */
  | { ok: false; held: Lease; stale: boolean }

export interface LeaseOptions {
  ttlMs?: number
  /** 只有确认旧租约已失效时才允许接管。 */
  takeover?: boolean
  now?: () => Date
}

const DEFAULT_TTL_MS = 60_000

function isLease(value: unknown): value is Lease {
  if (typeof value !== 'object' || value === null) return false
  const lease = value as Record<string, unknown>
  return typeof lease.owner === 'string' && lease.owner !== ''
    && Number.isSafeInteger(lease.pid) && (lease.pid as number) > 0
    && typeof lease.host === 'string' && lease.host !== ''
    && typeof lease.acquiredAt === 'string' && Number.isFinite(Date.parse(lease.acquiredAt))
    && typeof lease.heartbeatAt === 'string' && Number.isFinite(Date.parse(lease.heartbeatAt))
    && typeof lease.ttlMs === 'number' && Number.isFinite(lease.ttlMs) && lease.ttlMs > 0
}

/** 读取租约；文件不存在返回 undefined，内容损坏直接报错（不能把坏租约当成空租约）。 */
export async function readLease(taktDir: string): Promise<Lease | undefined> {
  const file = leaseFile(taktDir)
  const value = await readJsonFile<unknown>(file)
  if (value === undefined) return undefined
  if (!isLease(value)) throw new Error(`租约文件损坏：${file}`)
  return value
}

/** 同 host 只有 ESRCH 才算进程不存在；EPERM 等仍视为存活，避免误接管活进程。 */
function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

function isStale(lease: Lease, now: Date): boolean {
  if (now.getTime() - Date.parse(lease.heartbeatAt) <= lease.ttlMs) return false
  if (lease.host !== hostname()) return true
  return !processAlive(lease.pid)
}

function sameHolder(lease: Lease, owner: string): boolean {
  return lease.owner === owner && lease.host === hostname()
}

function assertTtl(ttlMs: number | undefined): void {
  if (ttlMs !== undefined && (!Number.isFinite(ttlMs) || ttlMs <= 0)) throw new Error('ttlMs 必须是正数')
}

async function writeLease(file: string, lease: Lease): Promise<void> {
  await writeFileAtomic(file, toJsonText(lease))
}

/**
 * 获取租约。获取、续约、接管都在跨进程文件锁内完成，两个接管者不会先后都成功。
 * 同一 owner（同 host）重复获取视为续约；`takeover` 只在旧租约确实失效时生效。
 */
export async function acquireLease(taktDir: string, owner: string, opts: LeaseOptions = {}): Promise<LeaseResult> {
  // 空 owner 写出的租约连 readLease 自己都不认，必须写前拒绝。
  if (owner.trim() === '') throw new Error('租约 owner 不能为空')
  assertTtl(opts.ttlMs)
  const file = leaseFile(taktDir)
  return withFileLock(file, async () => {
    const now = opts.now?.() ?? new Date()
    const current = await readLease(taktDir)
    if (current) {
      if (sameHolder(current, owner)) {
        const renewed: Lease = {
          ...current,
          heartbeatAt: now.toISOString(),
          ...(opts.ttlMs === undefined ? {} : { ttlMs: opts.ttlMs }),
        }
        await writeLease(file, renewed)
        return { ok: true, lease: renewed }
      }
      const stale = isStale(current, now)
      if (!stale || opts.takeover !== true) return { ok: false, held: current, stale }
    }
    const lease: Lease = {
      owner,
      pid: process.pid,
      host: hostname(),
      acquiredAt: now.toISOString(),
      heartbeatAt: now.toISOString(),
      ttlMs: opts.ttlMs ?? DEFAULT_TTL_MS,
    }
    await writeLease(file, lease)
    return { ok: true, lease }
  })
}

/** 续约；不是自己（同 host）持有时抛错，不覆盖别人的租约。 */
export async function renewLease(taktDir: string, owner: string, opts: { now?: () => Date } = {}): Promise<Lease> {
  const file = leaseFile(taktDir)
  return withFileLock(file, async () => {
    const current = await readLease(taktDir)
    if (!current) throw new Error(`没有可续约的空间租约：${taktDir}`)
    if (!sameHolder(current, owner)) throw new Error(`空间租约不属于 ${owner}：当前 ${current.owner}@${current.host}`)
    const renewed: Lease = { ...current, heartbeatAt: (opts.now?.() ?? new Date()).toISOString() }
    await writeLease(file, renewed)
    return renewed
  })
}

/** 释放；只有持有者能释放，租约不存在时静默。 */
export async function releaseLease(taktDir: string, owner: string): Promise<void> {
  const file = leaseFile(taktDir)
  await withFileLock(file, async () => {
    const current = await readLease(taktDir)
    if (!current) return
    if (!sameHolder(current, owner)) throw new Error(`不能释放 ${current.owner}@${current.host} 持有的空间租约（当前 ${owner}）`)
    await rm(file, { force: true })
  })
}
