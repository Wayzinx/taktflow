import { lstat, mkdir, realpath, stat, symlink } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'
import type { RepoBinding, RepoManager } from '@taktflow/core'
import { collect, launch } from './runtime.js'

async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

export async function bootstrapWorktree(repo: RepoBinding, source: string, target: string): Promise<Awaited<ReturnType<RepoManager['createWorktree']>>['bootstrap']> {
  if (!repo.bootstrap && !repo.share?.length) return undefined
  const started = Date.now()
  const shared: string[] = []
  for (const directory of repo.share ?? []) {
    if (!directory || isAbsolute(directory) || directory.split(/[\\/]/).some(part => part === '..' || part === '.' || part === '.git')) throw new Error(`共享目录必须是仓库内的相对目录：${directory}`)
    const from = join(source, directory)
    const to = join(target, directory)
    if (!await exists(from) || await exists(to)) continue
    if (!(await stat(from)).isDirectory()) throw new Error(`共享源不是目录：${directory}`)
    let parentPath = target
    for (const part of directory.split('/').slice(0, -1)) {
      parentPath = join(parentPath, part)
      if (await exists(parentPath) && (await lstat(parentPath)).isSymbolicLink()) throw new Error(`共享目录穿过符号链接：${directory}`)
    }
    await mkdir(dirname(to), { recursive: true })
    const parent = relative(await realpath(target), await realpath(dirname(to)))
    if (parent === '..' || parent.startsWith(`..${sep}`) || isAbsolute(parent)) throw new Error(`共享目录越出 worktree：${directory}`)
    await symlink(await realpath(from), to, 'dir')
    shared.push(directory)
  }
  let output: string | undefined
  if (repo.bootstrap) {
    // 合并输出以保留 stdout / stderr 的发生顺序；只保留最后 40 行用于诊断。
    const child = launch('/bin/sh', ['-c', `exec 2>&1\n${repo.bootstrap}`], { cwd: target })
    let tail = ''
    child.stdout!.on('data', (chunk: Buffer | string) => { tail = (tail + chunk.toString()).split('\n').slice(-41).join('\n').slice(-64_000) })
    try {
      const result = await collect(child, undefined, 600_000)
      output = tail.trimEnd().split('\n').slice(-40).join('\n')
      if (result.code !== 0) throw new Error(`退出码 ${result.code}`)
    } catch (cause) {
      output = tail.trimEnd().split('\n').slice(-40).join('\n')
      throw new Error(`仓库 ${repo.id} worktree 引导失败：${cause instanceof Error ? cause.message : String(cause)}\n${output}`, { cause })
    }
  }
  return { command: repo.bootstrap, shared, ok: true, ms: Date.now() - started, output }
}
