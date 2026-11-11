import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { initProject } from '../store/project.js'
import type { RunState } from '../types.js'
import { runDelivery } from './delivery.js'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })

const state = (path: string, runId = 'run-1'): RunState => ({
  runId, workflowId: 'wf', workflowVersion: '1', requirementId: 'REQ-1', status: 'succeeded', startedAt: '2026-11-11T00:00:00.000Z', args: {}, expansions: [],
  nodes: { integration: { id: 'integration', status: 'succeeded', attempts: 1, outputs: [], inputs: [], result: { repo: 'app', path, branch: `takt/${runId}/integration` } } },
} as unknown as RunState)

it('成品在集成分支：列出改动里能打开的网页（index.html 在前）和说明文件，没合进默认分支；合进去后 merged', async () => {
  const root = await mkdtemp(join(tmpdir(), 'takt-delivery-')); roots.push(root)
  const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@localhost', ...args], { cwd, encoding: 'utf8' }).trim()
  git(root, 'init', '--quiet', '-b', 'main')
  await writeFile(join(root, 'base.txt'), 'base\n')
  git(root, 'add', '.'); git(root, 'commit', '--quiet', '-m', 'base')
  const tree = join(root, '.takt/worktrees/run-1/integration')
  git(root, 'worktree', 'add', '--quiet', '-b', 'takt/run-1/integration', tree)
  await mkdir(join(tree, 'games/tank'), { recursive: true })
  for (const file of ['games/tank/about.html', 'games/tank/index.html', 'games/tank/logic.js', 'games/tank/README.md']) await writeFile(join(tree, file), 'x\n')
  git(tree, 'add', '.'); git(tree, 'commit', '--quiet', '-m', 'game')

  const stores = await initProject(root)
  stores.config.repos = [{ id: 'app', path: '.', defaultBranch: 'main' }]
  expect(await runDelivery(stores, state(tree))).toEqual({
    runId: 'run-1', repo: 'app', branch: 'takt/run-1/integration', path: '.takt/worktrees/run-1/integration', defaultBranch: 'main', merged: false,
    files: 4, entries: ['games/tank/index.html', 'games/tank/about.html'], readme: 'games/tank/README.md',
  })
  git(root, 'merge', '--quiet', '--no-edit', 'takt/run-1/integration')
  expect(await runDelivery(stores, state(tree))).toMatchObject({ merged: true })
  // 没有集成节点、工作树已经清掉：没有成品
  expect(await runDelivery(stores, { ...state(tree), nodes: {} })).toBeUndefined()
  expect(await runDelivery(stores, state(join(root, 'gone')))).toBeUndefined()
})
