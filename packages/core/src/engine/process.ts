import { spawn } from 'node:child_process'

export function command(run: string, cwd: string, env: Record<string, string>, signal?: AbortSignal): Promise<{ code: number; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn('sh', ['-c', run], { cwd, env: { ...process.env, ...env }, signal })
    let output = ''
    const collect = (chunk: Buffer) => { output = Buffer.from(output + chunk.toString()).subarray(-4096).toString() }
    child.stdout.on('data', collect)
    child.stderr.on('data', collect)
    child.on('error', reject)
    child.on('close', (code) => resolve({ code: code ?? -1, output }))
  })
}

export class Semaphore {
  private count = 0
  private readonly waiters: Array<() => void> = []
  constructor(private readonly limit: number) {}
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
