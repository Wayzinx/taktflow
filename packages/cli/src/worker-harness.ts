import { spawn } from 'node:child_process'
import { constants } from 'node:fs'
import { access, realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { delimiter, isAbsolute, join, relative, sep } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

const OUTPUT_BYTES = 16 * 1024
const MAX_RUN_MS = 30 * 60 * 1000
const ARGS = [
  'exec', '--sandbox', 'workspace-write', '--ignore-user-config', '--ignore-rules', '--ephemeral', '--skip-git-repo-check',
  '--color', 'never', '--disable', 'hooks', '-c', 'approval_policy="never"',
  '-c', 'sandbox_workspace_write.writable_roots=[]', '-c', 'sandbox_workspace_write.network_access=false',
  '-c', 'sandbox_workspace_write.exclude_tmpdir_env_var=true', '-c', 'sandbox_workspace_write.exclude_slash_tmp=true',
  '-c', 'shell_environment_policy.inherit="none"', '-',
]

export interface WorkerOutcome { status: 'succeeded' | 'failed'; result: string }

const failed = (result: string): WorkerOutcome => ({ status: 'failed', result })

export function inside(root: string, path: string): boolean {
  const rel = relative(root, path)
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`))
}

async function locate(cwd: string) {
  const dirs = await Promise.all((process.env.PATH ?? '').split(delimiter).filter(isAbsolute).map((path) => realpath(path).catch(() => undefined)))
  const trusted = dirs.filter((path): path is string => path !== undefined && !inside(cwd, path))
  for (const dir of trusted) {
    const file = await realpath(join(dir, 'codex')).catch(() => undefined)
    if (!file || inside(cwd, file) || !(await stat(file)).isFile()) continue
    if (await access(file, constants.X_OK).then(() => true, () => false)) return { file, path: trusted.join(delimiter) }
  }
  throw new Error('找不到可执行的 codex；请在工作目录之外的绝对 PATH 中安装 Codex')
}

export async function workerDirectories(project: string) {
  if (process.platform !== 'darwin' && process.platform !== 'linux') throw new Error('Team Worker 目前仅支持 macOS / Linux')
  const cwd = await realpath(project)
  const home = await realpath(homedir())
  const operatorConfig = process.env.TAKT_WORKER_CODEX_HOME
  const configured = operatorConfig || process.env.CODEX_HOME || join(home, '.codex')
  if (!isAbsolute(configured)) throw new Error('CODEX_HOME 必须是绝对路径')
  const codexHome = await realpath(configured).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return configured
    throw error
  })
  if (!(await stat(cwd)).isDirectory() || inside(cwd, home) || inside(cwd, codexHome) || inside(codexHome, cwd)) {
    throw new Error('--project 必须是与 HOME / CODEX_HOME 分离的专用工作目录')
  }
  return { cwd, home, codexHome, operatorConfig }
}

export async function localCodex(project: string): Promise<(prompt: string, signal: AbortSignal) => Promise<WorkerOutcome>> {
  const { cwd, home, codexHome, operatorConfig } = await workerDirectories(project)
  const { file, path } = await locate(cwd)
  const env = { PATH: path, HOME: home, CODEX_HOME: codexHome, LANG: process.env.LANG, LC_ALL: process.env.LC_ALL }
  const args = operatorConfig ? ARGS.filter(arg => arg !== '--ignore-user-config') : ARGS
  return (prompt, signal) => execute(file, args, cwd, env, prompt, signal)
}

function execute(file: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, prompt: string, signal: AbortSignal): Promise<WorkerOutcome> {
  if (signal.aborted) return Promise.resolve(failed('Worker 已停止；任务未运行。'))
  return new Promise((resolve) => {
    const child = spawn(file, args, { cwd, env, shell: false, detached: true, stdio: ['pipe', 'pipe', 'ignore'] })
    const output = Buffer.alloc(OUTPUT_BYTES)
    let size = 0
    let truncated = false
    let failure: string | undefined
    let stopping: Promise<void> | undefined
    const kill = (signal: NodeJS.Signals) => {
      if (!child.pid) return
      try { process.kill(-child.pid, signal) } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') failure = '无法停止 Codex 进程组，请检查 Worker。'
      }
    }
    const stop = (reason: string) => {
      if (stopping) return
      failure = reason
      kill('SIGTERM')
      stopping = delay(1000).then(() => { kill('SIGKILL'); child.stdout.destroy(); child.stdin.destroy() })
    }
    const interrupted = () => stop('Worker 已停止或租约丢失；请检查工作目录。')
    const timer = setTimeout(() => stop('Codex 执行超时；请检查工作目录。'), MAX_RUN_MS)
    signal.addEventListener('abort', interrupted, { once: true })
    child.on('error', () => { failure ??= '无法启动本机 Codex。' })
    child.stdin.on('error', () => { failure ??= '无法将任务 prompt 传给 Codex。' })
    child.stdout.on('data', (chunk: Buffer) => {
      truncated ||= chunk.length > output.length - size
      size += chunk.copy(output, size)
    })
    child.once('close', (code, exitSignal) => {
      clearTimeout(timer)
      signal.removeEventListener('abort', interrupted)
      void Promise.resolve(stopping).then(() => {
        if (failure || code !== 0) { resolve(failed(failure ?? `Codex 运行失败（${exitSignal ?? code}）。`)); return }
        const text = output.subarray(0, size).toString('utf8').trim()
        if (!truncated && Buffer.byteLength(text) <= OUTPUT_BYTES) { resolve({ status: 'succeeded', result: text }); return }
        const prefix = Buffer.from(text).subarray(0, OUTPUT_BYTES - 40).toString('utf8')
        resolve({ status: 'succeeded', result: `${prefix}\n… (输出已截断)` })
      })
    })
    child.stdin.end(prompt)
  })
}
