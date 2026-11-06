import { spawn } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'

export function outputTail(text: string): string {
  const bytes = Buffer.from(text)
  let offset = Math.max(0, bytes.length - 4096)
  while (offset < bytes.length && (bytes[offset]! & 0xc0) === 0x80) offset++
  return bytes.subarray(offset).toString()
}

export interface CommandOutputOptions {
  redact?: (text: string) => string
  redactionOverlap?: number
  onOutput?: (text: string) => void
}

export function command(run: string, cwd: string, env: Record<string, string>, signal?: AbortSignal, options: CommandOutputOptions = {}): Promise<{ code: number; output: string }> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason); return }
    const grouped = process.platform !== 'win32'
    const child = spawn('sh', ['-c', run], { cwd, env: { ...process.env, ...env }, detached: grouped })
    let output = ''
    const tail = () => outputTail(options.redact?.(output) ?? output)
    let settled = false
    let stopping = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const cleanup = () => {
      settled = true
      signal?.removeEventListener('abort', abort)
      if (timer) clearTimeout(timer)
    }
    const terminate = (kind: NodeJS.Signals) => {
      if (!child.pid) return
      try {
        if (grouped) process.kill(-child.pid, kind)
        else child.kill(kind)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
      }
    }
    const abort = () => {
      if (settled || stopping) return
      stopping = true
      try { terminate('SIGTERM') } catch (error) { cleanup(); reject(error); return }
      // 只杀 shell 会留下后台任务；等待短暂退出窗口后收掉整个进程组。
      timer = setTimeout(() => {
        try { terminate('SIGKILL') } catch (error) { cleanup(); reject(error); return }
        options.onOutput?.(tail())
        cleanup()
        reject(signal?.reason ?? new Error('命令已取消'))
      }, 100)
    }
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) abort()
    // 保留脱敏匹配窗口，避免先截断再脱敏泄露被截开的变量值。
    const collect = (text: string) => { output = Buffer.from(output + text).subarray(-(4096 + (options.redactionOverlap ?? 0) * 8)).toString() }
    for (const stream of [child.stdout, child.stderr]) {
      const decoder = new StringDecoder('utf8')
      stream.on('data', (chunk: Buffer) => collect(decoder.write(chunk)))
      stream.on('end', () => collect(decoder.end()))
    }
    child.on('error', (error) => { if (!settled && !stopping) { cleanup(); reject(error) } })
    child.on('close', (code) => {
      options.onOutput?.(tail())
      if (!settled && !stopping) { cleanup(); resolve({ code: code ?? -1, output: tail() }) }
    })
  })
}

export class Semaphore {
  private count = 0
  private readonly waiters: Array<() => void> = []
  constructor(private limit: number) {}
  setLimit(limit: number): void { this.limit = limit }
  async use<T>(fn: () => Promise<T>): Promise<T> {
    if (this.count >= this.limit) await new Promise<void>((resolve) => this.waiters.push(resolve))
    else this.count++
    try { return await fn() } finally {
      const next = this.waiters.shift()
      if (next) next()
      else this.count--
    }
  }
}
