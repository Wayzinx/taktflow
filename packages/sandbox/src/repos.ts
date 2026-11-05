import { access, mkdir, realpath, lstat } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { assertNodeId, assertRunId, sha256, withLock, type RepoBinding, type RepoManager } from '@taktflow/core'
import { collect, launch } from './runtime.js'

async function git(cwd: string, args: string[], allowed = [0]): Promise<string> {
  const result = await collect(launch('git', ['-C', cwd, ...args]), undefined, 120_000)
  if (!allowed.includes(result.code)) throw new Error(`git ${args[0]} failed in ${cwd} (exit ${result.code})`)
  return result.stdout
}

function safeNode(node: string): string {
  assertNodeId(node)
  return /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(node)
    ? node : `${node.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80)}-${sha256(node).slice(0, 16)}`
}

export function createRepoManager(options: { projectDir: string; taktDir: string; repos: RepoBinding[] }): RepoManager {
  const repos = structuredClone(options.repos)
  const worktrees = resolve(options.taktDir, 'worktrees')
  for (const repo of repos) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(repo.id)) throw new Error(`Invalid repo ID: ${repo.id}`)
  }
  if (new Set(repos.map(repo => repo.id)).size !== repos.length) throw new Error('Duplicate repo IDs')

  function binding(id: string): RepoBinding {
    const repo = repos.find(repo => repo.id === id)
    if (!repo) throw new Error(`Unknown repository: ${id}`)
    return repo
  }
  function source(repo: RepoBinding): string {
    return repo.url ? resolve(options.taktDir, 'repos', repo.id) : resolve(options.projectDir, repo.path)
  }
  async function key(repo: RepoBinding): Promise<string> {
    if (repo.url) return source(repo)
    return realpath((await git(source(repo), ['rev-parse', '--path-format=absolute', '--git-common-dir'])).trim())
  }
  async function sync(repo: RepoBinding): Promise<string> {
    const dir = source(repo)
    if (repo.url) {
      try { await access(dir) } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        await mkdir(dirname(dir), { recursive: true })
        await git(options.projectDir, ['clone', '--mirror', '--', repo.url, dir])
      }
      // 只更新远程 heads；不能用 mirror refspec 删除正在使用的 takt 分支。
      await git(dir, ['fetch', '--prune', 'origin', '+refs/heads/*:refs/remotes/origin/*'])
    }
    return (await git(dir, ['rev-parse', '--verify', '--end-of-options', `${repo.url ? 'refs/remotes/origin/' : 'refs/heads/'}${repo.defaultBranch}^{commit}`])).trim()
  }
  async function owner(path: string): Promise<{ path: string; source: string; key: string }> {
    const target = resolve(path)
    const rel = relative(worktrees, target)
    if (!rel || rel.startsWith(`..${sep}`) || rel === '..' || isAbsolute(rel) || rel.split(sep).length !== 2) throw new Error('Worktree path is outside managed run/node directories')
    if ((await lstat(target)).isSymbolicLink()) throw new Error('Worktree path must not be a symlink')
    const actual = await realpath(target)
    if (actual !== join(await realpath(worktrees), rel)) throw new Error('Worktree path traverses a symlink')
    const common = await realpath((await git(target, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).trim())
    for (const repo of repos) {
      const dir = source(repo)
      const repoCommon = repo.url ? await realpath(dir) : await key(repo)
      if (repoCommon === common) return { path: target, source: dir, key: await key(repo) }
    }
    throw new Error('Worktree does not belong to a configured repository')
  }
  return {
    list: () => structuredClone(repos),
    async sync(repoId) {
      const repo = binding(repoId)
      return withLock(await key(repo), async () => ({ head: await sync(repo) }))
    },
    async createWorktree(input) {
      const repo = binding(input.repoId)
      assertRunId(input.runId)
      const node = safeNode(input.nodeId)
      const path = join(worktrees, input.runId, node)
      const branch = `takt/${input.runId}/${input.nodeId}`
      return withLock(await key(repo), async () => {
        const latest = await sync(repo)
        await git(source(repo), ['check-ref-format', '--branch', branch])
        const base = input.base === undefined ? latest : (await git(source(repo), ['rev-parse', '--verify', '--end-of-options', `${input.base}^{commit}`])).trim()
        await mkdir(dirname(path), { recursive: true })
        await git(source(repo), ['worktree', 'add', '-b', branch, path, base])
        return { path, branch, base }
      })
    },
    async diff(worktreePath, base) {
      const repo = await owner(worktreePath)
      return withLock(repo.key, async () => {
        const commit = (await git(repo.path, ['rev-parse', '--verify', '--end-of-options', `${base}^{commit}`])).trim()
        let patch = await git(repo.path, ['diff', '--binary', '--no-ext-diff', '--no-textconv', commit, '--'])
        const changed = await git(repo.path, ['diff', '--name-only', '-z', commit, '--'])
        const untracked = (await git(repo.path, ['ls-files', '--others', '--exclude-standard', '-z'])).split('\0').filter(Boolean)
        for (const file of untracked) patch += await git(repo.path, ['diff', '--no-index', '--binary', '--no-ext-diff', '--no-textconv', '--', '/dev/null', file], [0, 1])
        return { patch, files: [...new Set([...changed.split('\0').filter(Boolean), ...untracked])].sort() }
      })
    },
    async removeWorktree(worktreePath) {
      const repo = await owner(worktreePath)
      await withLock(repo.key, async () => {
        await git(repo.source, ['worktree', 'remove', '--force', repo.path])
        await git(repo.source, ['worktree', 'prune'])
      })
    },
  }
}
