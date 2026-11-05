import { mkdir, open, rm } from 'node:fs/promises'
import { dirname } from 'node:path'
import { setTimeout } from 'node:timers/promises'
import { withLock } from '@taktflow/core'

// 空间写入与 CLI 跨进程互斥；core 的文件锁尚未导出，不能依赖包内部路径。
export function spaceLock<T>(file: string, operation: () => Promise<T>): Promise<T> {
  return withLock(file, async () => {
    const lock = `${file}.lock`
    await mkdir(dirname(lock), { recursive: true })
    const deadline = Date.now() + 10000
    let handle
    for (;;) {
      try { handle = await open(lock, 'wx'); break } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        if (Date.now() >= deadline) throw new Error(`空间写入锁超时：${lock}`)
        await setTimeout(10)
      }
    }
    try { return await operation() } finally { await handle.close(); await rm(lock, { force: true }) }
  })
}
