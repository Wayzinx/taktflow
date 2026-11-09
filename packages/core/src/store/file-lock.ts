import { mkdir, realpath } from 'node:fs/promises'
import path from 'node:path'
import { setTimeout } from 'node:timers/promises'
import { withLock } from './locks.js'
import { sha256 } from '../util/hash.js'
import { acquireProcessFile } from './process-file.js'

// 单独使用文件锁，不改变 withLock 的重入关系；绝不按时间抢活锁。
async function canonicalPath(key: string): Promise<string> {
  let parent = path.resolve(key)
  const suffix: string[] = []
  for (;;) {
    try { return path.join(await realpath(parent), ...suffix) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      suffix.unshift(path.basename(parent))
      parent = path.dirname(parent)
    }
  }
}

export async function withFileLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const absolute = await canonicalPath(key)
  const parts = absolute.split(path.sep)
  const takt = parts.lastIndexOf('.takt')
  // 复用已被守卫排除的运行元数据目录，不在 workspace 中制造 lock 产物。
  const lock = takt >= 0
    ? path.join(parts.slice(0, takt + 1).join(path.sep), 'runs', '.locks', `${sha256(absolute)}.lock`)
    : `${absolute}.lock`
  return withLock(lock, async () => {
    await mkdir(path.dirname(lock), { recursive: true })
    const deadline = Date.now() + 10_000
    let release: () => Promise<void>
    for (;;) {
      const acquired = await acquireProcessFile(lock)
      if ('release' in acquired) {
        release = acquired.release
        break
      }
      if (Date.now() >= deadline) throw new Error(`等待文件锁超时（请确认持有进程已退出后清理）：${lock}`)
      await setTimeout(10)
    }
    try {
      return await fn()
    } finally { await release() }
  })
}
