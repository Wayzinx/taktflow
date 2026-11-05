import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
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
