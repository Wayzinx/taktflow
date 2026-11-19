import { UsageError } from './args.js'

const MAX_CODE_BYTES = 256
const invalid = () => new UsageError('请从 stdin 输入单行 ASCII 配对码（22–256 个 URL-safe 字符）')

function validate(bytes: Buffer): string {
  const code = bytes.toString('latin1').replace(/\r?\n$/, '')
  if (!/^[A-Za-z0-9_-]{22,256}$/.test(code)) throw invalid()
  return code
}

export async function readLinkCode(stop: AbortController): Promise<string> {
  const { stdin } = process
  const { signal } = stop
  const tty = stdin.isTTY === true
  const wasRaw = stdin.isRaw
  const input = Buffer.alloc(MAX_CODE_BYTES + 2)
  let size = 0
  signal.throwIfAborted()
  if (tty) {
    stdin.setRawMode(true)
    process.stderr.write('请输入 Team Hub 配对码（不回显）：\n')
  }
  let cleanup = () => {}
  try {
    return validate(await new Promise<Buffer>((resolve, reject) => {
      const end = () => resolve(input.subarray(0, size))
      const abort = () => reject(signal.reason)
      const failed = () => reject(new Error('无法从 stdin 读取配对码'))
      const data = (chunk: Buffer) => {
        if (!tty) {
          if (chunk.length > input.length - size) return reject(invalid())
          size += chunk.copy(input, size)
          return
        }
        for (const [index, byte] of chunk.entries()) {
          if (byte === 3) return stop.abort()
          if (byte === 4) return reject(invalid())
          if (byte === 13 || byte === 10) {
            if (index + 1 === chunk.length || (byte === 13 && index + 2 === chunk.length && chunk[index + 1] === 10)) return end()
            return reject(invalid())
          }
          if (byte === 8 || byte === 127) size = Math.max(size - 1, 0)
          else if (size === MAX_CODE_BYTES) return reject(invalid())
          else input[size++] = byte
        }
      }
      cleanup = () => {
        signal.removeEventListener('abort', abort)
        stdin.off('data', data).off('end', end).off('error', failed)
      }
      signal.addEventListener('abort', abort, { once: true })
      stdin.on('data', data).once('end', end).once('error', failed)
      if (stdin.readableEnded) end()
    }))
  } finally {
    cleanup()
    stdin.pause()
    if (tty) stdin.setRawMode(wasRaw)
  }
}
