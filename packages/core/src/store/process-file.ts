import { open, readFile, unlink, type FileHandle } from 'node:fs/promises'
import { hostname } from 'node:os'
import { dirname, join } from 'node:path'
import { sha256 } from '../util/hash.js'

interface Owner { pid?: number; host?: string }
interface Observed { identity: string; owner: Owner }

function parseOwner(text: string): Owner {
  try {
    const value: unknown = JSON.parse(text)
    return value !== null && typeof value === 'object' ? value as Owner : {}
  } catch { return {} }
}

export function ownerIsDead(owner: Owner): boolean {
  if (owner.host !== undefined && owner.host !== hostname()) return false
  if (!Number.isSafeInteger(owner.pid) || owner.pid! <= 0) return false
  try { process.kill(owner.pid!, 0); return false } catch (error) {
    // EPERM 和其他无法确认的错误都不能证明进程已退出。
    return (error as NodeJS.ErrnoException).code === 'ESRCH'
  }
}

export async function readProcessOwner(file: string): Promise<Owner | undefined> {
  try { return parseOwner(await readFile(file, 'utf8')) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    return {}
  }
}

async function observe(file: string): Promise<Observed | undefined> {
  let handle: FileHandle | undefined
  try {
    handle = await open(file, 'r')
    const stat = await handle.stat({ bigint: true })
    const text = await handle.readFile('utf8')
    return { identity: sha256(`${stat.dev}:${stat.ino}:${stat.birthtimeNs}:${text}`), owner: parseOwner(text) }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    return { identity: '', owner: {} }
  } finally { await handle?.close() }
}

type Acquisition = { release: () => Promise<void> } | { owner: Owner }

export async function acquireProcessFile(file: string, extra: Record<string, unknown> = {}): Promise<Acquisition> {
  for (;;) {
    let handle: FileHandle
    try { handle = await open(file, 'wx') } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      const before = await observe(file)
      if (!before) continue
      if (!ownerIsDead(before.owner)) return { owner: before.owner }
      // 每一代文件有独立的回收锁：旧等待者不会与新一代的回收者共用互斥身份。
      // 持有回收锁后重读身份，再删死锁；其他回收者不能在重读与 unlink 间替换它。
      // 回收锁崩溃遗留时递归使用同一协议，绝不按时间或直接 unlink 抢回收锁。
      const guard = join(dirname(file), `${sha256(file + before.identity)}.reclaim`)
      const acquired = await acquireProcessFile(guard)
      if (!('release' in acquired)) return { owner: acquired.owner }
      try {
        const current = await observe(file)
        if (current?.identity === before.identity && ownerIsDead(current.owner)) await unlink(file)
      } finally { await acquired.release() }
      continue
    }
    try { await handle.writeFile(JSON.stringify({ ...extra, pid: process.pid, host: hostname() })) } catch (error) {
      await handle.close()
      await unlink(file)
      throw error
    }
    return { release: async () => { try { await unlink(file) } finally { await handle.close() } } }
  }
}
