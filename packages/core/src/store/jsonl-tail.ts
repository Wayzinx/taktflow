import { statSync } from 'node:fs'
import { open, stat } from 'node:fs/promises'
import { StringDecoder } from 'node:string_decoder'
import { isEnoent } from './fs-utils.js'

const POLL_INTERVAL_MS = 300

/** 从订阅时的字节偏移读取完整行，供事件和群聊共用。 */
export function subscribeJsonLines<T>(file: string, onLine: (value: T) => void): () => void {
  let decoder = new StringDecoder('utf8')
  // 同步取当前字节偏移：订阅只关心之后追加的事件，不能漏掉 subscribe 返回后立刻写入的那条
  let offset = 0
  try {
    offset = statSync(file).size
  } catch (err) {
    if (!isEnoent(err)) throw err
  }
  let pending = ''
  let reading = false
  let closed = false

  const poll = async (): Promise<void> => {
    if (closed || reading) return
    reading = true
    try {
      let size: number
      try {
        size = (await stat(file)).size
      } catch (err) {
        if (isEnoent(err)) return
        throw err
      }
      if (size < offset) {
        // 文件被替换或截断：从头重新跟上
        offset = 0
        pending = ''
        decoder = new StringDecoder('utf8')
      }
      if (size === offset) return
      const handle = await open(file, 'r')
      try {
        const buf = Buffer.alloc(size - offset)
        const { bytesRead } = await handle.read(buf, 0, buf.length, offset)
        offset += bytesRead
        pending += decoder.write(buf.subarray(0, bytesRead))
      } finally {
        await handle.close()
      }
      let idx: number
      while (!closed && (idx = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, idx)
        pending = pending.slice(idx + 1)
        if (line.trim() === '') continue
        try {
          onLine(JSON.parse(line) as T)
        } catch {
          // 坏行由存储读取或审计报告；订阅继续跟进后续行
        }
      }
    } catch {
      // 文件暂时不可读（例如正在被替换）时下个 tick 重试
    } finally {
      reading = false
    }
  }

  const timer = setInterval(() => {
    void poll()
  }, POLL_INTERVAL_MS)
  timer.unref()
  return () => {
    closed = true
    clearInterval(timer)
  }
}
