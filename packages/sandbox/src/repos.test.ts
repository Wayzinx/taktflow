import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { access, lstat, mkdir, mkdtemp, readFile, readlink, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRepoManager } from './repos.js'

const exec = promisify(execFile)
let root: string
async function git(dir: string, ...args: string[]) { return (await exec('git', ['-C', dir, ...args])).stdout.trim() }
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'takt-repos-'))
  await mkdir(join(root, 'repo'))
  await git(join(root, 'repo'), 'init', '-b', 'main')
  await git(join(root, 'repo'), 'config', 'user.name', 'Test')
  await git(join(root, 'repo'), 'config', 'user.email', 'test@example.invalid')
  await writeFile(join(root, 'repo', 'file.txt'), 'base\n')
  await git(join(root, 'repo'), 'add', '.')
  await git(join(root, 'repo'), 'commit', '-m', 'base')
})
afterEach(async () => { await rm(root, { recursive: true, force: true }) })
function manager(remote = false) {
  return createRepoManager({ projectDir: root, taktDir: join(root, '.takt'), repos: [{ id: 'app', path: 'repo', defaultBranch: 'main', ...(remote ? { url: join(root, 'repo') } : {}) }] })
}

it('creates isolated parallel worktrees, includes staged/unstaged/untracked diffs and removes them', async () => {
  const repos = manager()
  const [one, two] = await Promise.all([
    repos.createWorktree({ repoId: 'app', runId: 'run-1', nodeId: 'plan/a' }),
    manager().createWorktree({ repoId: 'app', runId: 'run-1', nodeId: 'plan_a' }),
  ])
  expect(one.path).not.toBe(two.path)
  expect(one.branch).toBe('takt/run-1/plan/a')
  expect(one.base).toBe((await repos.sync('app')).head)
  await writeFile(join(one.path, 'file.txt'), 'staged\n')
  await git(one.path, 'add', 'file.txt')
  await writeFile(join(one.path, 'file.txt'), 'changed\n')
  await writeFile(join(one.path, 'new file.txt'), 'new\n')
  const diff = await repos.diff(one.path, one.base)
  expect(diff.files).toEqual(['file.txt', 'new file.txt'])
  expect(diff.patch).toContain('-base\n+changed')
  expect(diff.patch).toContain('+new')
  expect((await repos.diff(two.path, two.base)).files).toEqual([])
  expect(await readFile(join(root, 'repo', 'file.txt'), 'utf8')).toBe('base\n')
  await Promise.all([repos.removeWorktree(one.path), repos.removeWorktree(two.path)])
  await expect(access(one.path)).rejects.toThrow()
  expect(await git(join(root, 'repo'), 'worktree', 'list')).not.toContain('run-1')
})

it('mirrors and fetches the latest default branch without overwriting active task branches', async () => {
  const repos = manager(true)
  const first = await repos.createWorktree({ repoId: 'app', runId: 'run-1', nodeId: 'one' })
  await writeFile(join(root, 'repo', 'file.txt'), 'new-base\n')
  await git(join(root, 'repo'), 'commit', '-am', 'next')
  const second = await repos.createWorktree({ repoId: 'app', runId: 'run-1', nodeId: 'two' })
  expect(first.base).not.toBe(second.base)
  expect(await readFile(join(first.path, 'file.txt'), 'utf8')).toBe('base\n')
  expect(await readFile(join(second.path, 'file.txt'), 'utf8')).toBe('new-base\n')
  expect(await git(join(root, '.takt/repos/app'), 'rev-parse', first.branch)).toBe(first.base)
  const pinned = await repos.createWorktree({ repoId: 'app', runId: 'run-2', nodeId: 'pinned', base: first.base })
  expect(pinned.base).toBe(first.base)
  await Promise.all([first, second, pinned].map(tree => repos.removeWorktree(tree.path)))
})

it('rejects path escapes and duplicate worktrees without deleting the existing one', async () => {
  const repos = manager()
  await expect(repos.createWorktree({ repoId: 'app', runId: '../escape', nodeId: 'one' })).rejects.toThrow()
  await expect(repos.createWorktree({ repoId: 'app', runId: 'run', nodeId: '../escape' })).rejects.toThrow()
  await expect(repos.removeWorktree(join(root, 'repo'))).rejects.toThrow('outside')
  const input = { repoId: 'app', runId: 'run', nodeId: 'one' }
  const worktree = await repos.createWorktree(input)
  await expect(repos.createWorktree(input)).rejects.toThrow()
  expect(await readFile(join(worktree.path, 'file.txt'), 'utf8')).toBe('base\n')
  await repos.removeWorktree(worktree.path)
})

it('shares only missing directories before bootstrap, preserves tracked directories, and reports bootstrap output', async () => {
  await mkdir(join(root, 'repo', 'node_modules'))
  await writeFile(join(root, 'repo', 'node_modules', 'dependency.txt'), 'available')
  await mkdir(join(root, 'repo', 'tracked'))
  await writeFile(join(root, 'repo', 'tracked', 'file'), 'tracked')
  await git(join(root, 'repo'), 'add', 'tracked')
  await git(join(root, 'repo'), 'commit', '-m', 'tracked directory')
  const repos = createRepoManager({ projectDir: root, taktDir: join(root, '.takt'), repos: [{ id: 'app', path: 'repo', defaultBranch: 'main', share: ['node_modules', 'tracked', 'missing'], bootstrap: 'cat node_modules/dependency.txt > boot.txt; echo bootstrap-ok' }] })
  const created = await repos.createWorktree({ repoId: 'app', runId: 'run-boot', nodeId: 'dev' })
  expect(await readlink(join(created.path, 'node_modules'))).toBe(await realpath(join(root, 'repo', 'node_modules')))
  expect((await lstat(join(created.path, 'tracked'))).isSymbolicLink()).toBe(false)
  expect(await readFile(join(created.path, 'boot.txt'), 'utf8')).toBe('available')
  expect(created.bootstrap).toMatchObject({ shared: ['node_modules'], ok: true, output: 'bootstrap-ok', ms: expect.any(Number) })
})

it('remote mirror uses a working checkout as share source', async () => {
  await mkdir(join(root, 'repo', 'shared'))
  await writeFile(join(root, 'repo', 'shared', 'file'), 'remote')
  await git(join(root, 'repo'), 'add', 'shared')
  await git(join(root, 'repo'), 'commit', '-m', 'share source')
  const repos = createRepoManager({ projectDir: root, taktDir: join(root, '.takt'), repos: [{ id: 'app', url: join(root, 'repo'), path: 'unused', defaultBranch: 'main', share: ['node_modules'] }] })
  const one = await repos.createWorktree({ repoId: 'app', runId: 'run-remote', nodeId: 'one' })
  expect(one.bootstrap?.shared).toEqual([])
  const checkout = join(root, '.takt/repos/app-checkout')
  expect(await readFile(join(checkout, 'shared/file'), 'utf8')).toBe('remote')
  await mkdir(join(checkout, 'node_modules'))
  await writeFile(join(checkout, 'node_modules/dependency'), 'cached')
  const two = await repos.createWorktree({ repoId: 'app', runId: 'run-remote', nodeId: 'two' })
  expect(two.bootstrap?.shared).toEqual(['node_modules'])
  expect(await readFile(join(two.path, 'node_modules/dependency'), 'utf8')).toBe('cached')
})

it('bootstrap failure includes the final 40 lines and cleans failed worktree for retry', async () => {
  const config = { id: 'app', path: 'repo', defaultBranch: 'main', bootstrap: 'i=1; while [ "$i" -le 50 ]; do echo "line-$i"; i=$((i+1)); done; echo error-tail >&2; exit 7' }
  const repos = createRepoManager({ projectDir: root, taktDir: join(root, '.takt'), repos: [config] })
  const input = { repoId: 'app', runId: 'run-failed', nodeId: 'dev' }
  let message = ''
  try { await repos.createWorktree(input) } catch (error) { message = (error as Error).message }
  expect(message).toContain('退出码 7')
  expect(message.split('\n').slice(1)).toHaveLength(40)
  expect(message).toContain('line-12\n')
  expect(message).not.toContain('line-11\n')
  expect(message).toContain('error-tail')
  await expect(access(join(root, '.takt/worktrees/run-failed/dev'))).rejects.toThrow()
  const retry = createRepoManager({ projectDir: root, taktDir: join(root, '.takt'), repos: [{ ...config, bootstrap: 'echo repaired' }] })
  expect((await retry.createWorktree(input)).bootstrap?.output).toBe('repaired')
})

it.each(['../outside', '/absolute', '.git/config'])('rejects unsafe shared directory %s', async share => {
  const repos = createRepoManager({ projectDir: root, taktDir: join(root, '.takt'), repos: [{ id: 'app', path: 'repo', defaultBranch: 'main', share: [share] }] })
  await expect(repos.createWorktree({ repoId: 'app', runId: 'run-unsafe', nodeId: 'dev' })).rejects.toThrow('相对目录')
})
