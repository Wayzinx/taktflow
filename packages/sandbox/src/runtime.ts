import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { posix, resolve } from 'node:path'
import type { Sandbox, SandboxMount, SandboxSpec } from '@taktflow/core'

const inherited = ['PATH', 'HOME', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TMPDIR', 'TMP', 'TEMP', 'SHELL', 'USER', 'LOGNAME', 'TERM', 'TZ']

export function sandboxEnv(...overrides: Array<Record<string, string> | undefined>): Record<string, string> {
  const env: Record<string, string> = {}
  for (const key of inherited) if (process.env[key] !== undefined) env[key] = process.env[key]!
  return Object.assign(env, ...overrides)
}

export function launch(command: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv; stdin?: 'pipe' | 'ignore' } = {}): ChildProcess {
  const child = spawn(command, args, {
    cwd: options.cwd, env: options.env, stdio: [options.stdin ?? 'pipe', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
  })
  const kill = child.kill.bind(child)
  child.kill = (signal = 'SIGTERM') => {
    if (process.platform === 'win32' || !child.pid) return kill(signal)
    try { process.kill(-child.pid, signal); return true } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false
      throw error
    }
  }
  return child
}

export function collect(child: ChildProcess, input?: string, timeoutMs?: number): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    let stdout = ''; let stderr = ''; let failure: Error | undefined
    const timer = timeoutMs === undefined ? undefined : setTimeout(() => {
      failure = new Error(`Sandbox command timed out after ${timeoutMs}ms`)
      child.kill('SIGKILL')
    }, timeoutMs)
    child.stdout!.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk })
    child.stderr!.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk })
    child.once('error', error => { failure = error })
    child.stdin?.on('error', error => { if ((error as NodeJS.ErrnoException).code !== 'EPIPE') failure = error })
    child.stdin?.end(input)
    child.once('close', (code, signal) => {
      clearTimeout(timer)
      if (failure) reject(failure)
      else resolve({ code: code ?? (signal ? 128 : 1), stdout, stderr })
    })
  })
}

export async function probe(command: string, args: string[]): Promise<{ ok: boolean; reason?: string }> {
  try {
    const result = await collect(launch(command, args), undefined, 10_000)
    return result.code === 0 ? { ok: true } : { ok: false, reason: `${command} probe exited ${result.code}` }
  } catch (error) {
    return { ok: false, reason: `${command} unavailable (${(error as NodeJS.ErrnoException).code ?? 'probe failed or timed out'})` }
  }
}

export function mappedHostPath(path: string, mounts: SandboxMount[], identity: boolean): string {
  const normalized = posix.normalize(path)
  if (!posix.isAbsolute(normalized)) throw new Error(`Sandbox path must be absolute: ${path}`)
  const mount = [...mounts].sort((a, b) => b.target.length - a.target.length).find(item => {
    const target = posix.resolve(item.target)
    return normalized === target || normalized.startsWith(target === '/' ? '/' : `${target}/`)
  })
  if (mount) return resolve(mount.source, posix.relative(posix.resolve(mount.target), normalized))
  if (identity) return normalized
  throw new Error(`Sandbox path has no host mount: ${path}`)
}

export function managedSandbox(provider: string, spec: SandboxSpec, spawn: Sandbox['spawn'], hostPath: Sandbox['hostPath'], cleanup: () => Promise<void> = async () => {}, id: string = randomUUID()): Sandbox {
  let disposed = false
  let disposing: Promise<void> | undefined
  const children = new Set<ChildProcess>()
  const sandbox: Sandbox = {
    id, provider, spec,
    spawn(command, args, opts) {
      if (disposed) throw new Error(`Sandbox ${id} is disposed`)
      const child = spawn(command, args, opts)
      children.add(child)
      child.once('close', () => { children.delete(child) })
      return child
    },
    exec(command, args, opts = {}) {
      return collect(sandbox.spawn(command, args, opts), opts.input, opts.timeoutMs ?? spec.limits?.timeoutMs)
    },
    hostPath,
    dispose() {
      if (disposing) return disposing
      disposed = true
      disposing = (async () => {
        const closed = [...children].map(child => new Promise<void>(resolve => child.once('close', () => resolve())))
        for (const child of children) child.kill('SIGKILL')
        await cleanup()
        await Promise.all(closed)
      })()
      return disposing
    },
  }
  return sandbox
}
