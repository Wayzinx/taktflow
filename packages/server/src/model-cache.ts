import { mkdir, readFile, rename, writeFile, rm } from 'node:fs/promises'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { CatalogList } from '@taktflow/core'

export const MODEL_CACHE_TTL = 6 * 60 * 60 * 1000

interface Entry<T> { fingerprint: string; fetchedAt: string; value: T }
export interface CacheResult<T> { value?: T; fetchedAt?: string; source: CatalogList['source']; error?: string }

export async function modelDeadline<T>(work: (signal: AbortSignal) => Promise<T>, ms: number): Promise<T> {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([Promise.resolve().then(() => work(controller.signal)), new Promise<never>((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new Error(`获取模型超过 ${ms / 1000} 秒`)) }, ms)
    })])
  } finally { clearTimeout(timer) }
}

export async function writeModelCache(file: string, value: unknown): Promise<void> {
  await mkdir(dirname(file), { recursive: true })
  const temp = `${file}.${randomUUID()}.tmp`
  try {
    await writeFile(temp, JSON.stringify(value), { mode: 0o600 })
    await rename(temp, file)
  } finally { await rm(temp, { force: true }) }
}

/** provider、自带模型和补充元数据共用过期与单次刷新规则；失败不覆盖上次成功结果。 */
export class ModelCache<T> {
  private pending?: { fingerprint: string; promise: Promise<CacheResult<T>> }
  private failure?: { fingerprint: string; until: number; error: string }

  constructor(private readonly file: string, private readonly valid: (value: unknown) => value is T,
    private readonly now: () => number = Date.now) {}

  async get(fingerprint: string, load: (previous?: T) => Promise<T>, refresh = false): Promise<CacheResult<T>> {
    // 强制刷新时同一项正在拉就直接共用：先去读盘的话，可能读到它写盘前的旧缓存，等它结束再拿旧列表比对，下线标记就丢了
    if (refresh && this.pending?.fingerprint === fingerprint) return this.pending.promise
    let previous: Entry<T> | undefined
    try {
      const entry = JSON.parse(await readFile(this.file, 'utf8')) as Entry<T>
      if (entry.fingerprint === fingerprint && Number.isFinite(Date.parse(entry.fetchedAt)) && this.valid(entry.value)) previous = entry
    } catch { /* 缓存缺失或损坏时重新发现。 */ }
    const cached = previous ? { value: previous.value, fetchedAt: previous.fetchedAt, source: 'cache' as const } : undefined
    if (!refresh && cached && this.now() - Date.parse(cached.fetchedAt) < MODEL_CACHE_TTL) return cached
    if (!refresh && this.failure?.fingerprint === fingerprint && this.now() < this.failure.until) {
      return cached ? { ...cached, error: this.failure.error } : { source: 'preset', error: this.failure.error }
    }
    // 配置变更时也不能并发启动同一项；旧任务结束后再按新指纹拉取。
    if (this.pending && this.pending.fingerprint !== fingerprint) {
      await this.pending.promise
      return this.get(fingerprint, load, refresh)
    }
    if (!this.pending) {
      const promise = Promise.resolve().then(async (): Promise<CacheResult<T>> => {
        try {
          const value = await load(previous?.value)
          if (!this.valid(value)) throw new Error('列模型响应格式不正确')
          const fetchedAt = new Date(this.now()).toISOString()
          await writeModelCache(this.file, { fingerprint, fetchedAt, value })
          this.failure = undefined
          return { value, fetchedAt, source: 'live' }
        } catch (error) {
          const message = error instanceof Error ? error.message : '获取模型失败'
          this.failure = { fingerprint, until: this.now() + 30_000, error: message }
          return { source: 'preset', error: message }
        } finally { this.pending = undefined }
      })
      this.pending = { fingerprint, promise }
    }
    if (!refresh && cached) { void this.pending.promise; return cached }
    return this.pending.promise
  }
}
