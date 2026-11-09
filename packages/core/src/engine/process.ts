import { spawn } from 'node:child_process'
import { childEnv } from '../util/child-env.js'

export function command(run: string, cwd: string, env: Record<string, string>, signal?: AbortSignal): Promise<{ code: number; output: string }> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason); return }
    const grouped = process.platform !== 'win32'
    const child = spawn('sh', ['-c', run], { cwd, env: childEnv(env), detached: grouped })
    let output = ''
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
        cleanup()
        reject(signal?.reason ?? new Error('命令已取消'))
      }, 100)
    }
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) abort()
    const collect = (chunk: Buffer) => { output = Buffer.from(output + chunk.toString()).subarray(-4096).toString() }
    child.stdout.on('data', collect)
    child.stderr.on('data', collect)
    child.on('error', (error) => { if (!settled && !stopping) { cleanup(); reject(error) } })
    child.on('close', (code) => { if (!settled && !stopping) { cleanup(); resolve({ code: code ?? -1, output }) } })
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
