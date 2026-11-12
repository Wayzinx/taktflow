import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { createRepoManager } from '@taktflow/sandbox'
import { initProject } from '../store/project.js'
import type { ReviewRound, RunState, WorkflowSnapshot } from '../types.js'
import { targetFingerprint } from '../engine/nodes/review-target.js'
import { reviewDetail } from './reviews.js'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))) })

it('代码评审读取实时 diff 判断过期，不登记新版本；工作树已移除时返回 unknown', async () => {
  const root = await mkdtemp(join(tmpdir(), 'takt-review-freshness-')); roots.push(root)
  const source = join(root, 'app')
  await mkdir(source)
  execFileSync('git', ['init', '--quiet', '-b', 'main'], { cwd: source })
  await writeFile(join(source, 'app.ts'), 'export const value = 1\n')
  execFileSync('git', ['add', 'app.ts'], { cwd: source })
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--quiet', '-m', 'initial'], { cwd: source })
  const stores = await initProject(root)
  stores.config.repos = [{ id: 'app', path: 'app', defaultBranch: 'main' }]
  const requirementId = (await stores.workspaces.createRequirement({ title: '代码评审' })).id
  const repos = createRepoManager({ projectDir: root, taktDir: stores.taktDir, repos: stores.config.repos })
  const tree = await repos.createWorktree({ repoId: 'app', runId: 'run-code-review', nodeId: 'code' })
  await writeFile(join(tree.path, 'app.ts'), 'export const value = 2\n')
  const patch = (await repos.diff(tree.path, tree.base)).patch
  const ref = await stores.workspaces.writeArtifact({ ref: { workspace: requirementId, path: 'tasks/code.diff' }, content: patch, kind: 'code-change',
    author: { type: 'system', id: 'test' }, producedBy: { runId: 'run-code-review', nodeId: 'code' } })
  const run: RunState = { runId: 'run-code-review', requirementId, workflowId: 'w', workflowVersion: '1', status: 'succeeded', startedAt: new Date().toISOString(), args: {}, expansions: [],
    nodes: { code: { id: 'code', status: 'succeeded', attempts: 1, outputs: [ref], worktree: { ...tree, repo: 'app' } },
      review: { id: 'review', status: 'succeeded', attempts: 1, outputs: [], revision: 1, round: 1, result: { passed: true } } } }
  const snapshot: WorkflowSnapshot = { id: 'w', title: 'w', version: '1', stages: [], nodes: [
    { id: 'code', kind: 'agent', title: '代码', needs: [], repo: 'app', role: 'dev' },
    { id: 'review', kind: 'review', title: '评审', needs: ['code'], review: { target: { code: { repo: 'app' } }, author: 'dev',
      reviewers: [{ role: 'qa' }], maxRounds: 1, onExhausted: 'fail', pass: 'all' } },
  ] }
  await stores.runs.create(run, snapshot)
  const round: ReviewRound = { round: 1, revision: 1, seq: 1, passed: true, responses: [], revised: [],
    targetFingerprint: await targetFingerprint(stores.workspaces, [ref], true),
    records: [{ round: 1, reviewer: 'qa', verdict: 'approve', summary: '无问题', issues: [], artifacts: [ref], at: new Date().toISOString() }] }
  await stores.workspaces.writeArtifact({ ref: { workspace: requirementId, path: 'reviews/review/r1-round-1.json' }, content: JSON.stringify(round), kind: 'review',
    author: { type: 'system', id: 'test' }, producedBy: { runId: run.runId, nodeId: 'review' } })
  const manifest = await stores.workspaces.listArtifacts(requirementId)
  expect((await reviewDetail(stores, run.runId, 'review'))?.facets).toMatchObject({ freshness: 'current', coverage: 'full', outcome: 'no_findings' })
  await writeFile(join(tree.path, 'app.ts'), 'export const value = 3\n')
  expect((await reviewDetail(stores, run.runId, 'review'))?.facets?.freshness).toBe('stale')
  expect(await stores.workspaces.listArtifacts(requirementId)).toEqual(manifest)
  await repos.removeWorktree(tree.path)
  expect((await reviewDetail(stores, run.runId, 'review'))?.facets?.freshness).toBe('unknown')
})

it('分支没走到、被跳过的评审节点是"跳过"，不是"评审中"', async () => {
  const root = await mkdtemp(join(tmpdir(), 'takt-review-skipped-')); roots.push(root)
  const stores = await initProject(root)
  const requirementId = (await stores.workspaces.createRequirement({ title: '跳过的评审' })).id
  const run: RunState = { runId: 'run-skipped-review', requirementId, workflowId: 'w', workflowVersion: '1', status: 'succeeded', startedAt: new Date().toISOString(), args: {}, expansions: [],
    nodes: { review: { id: 'review', status: 'skipped', attempts: 0, outputs: [] } } }
  const snapshot: WorkflowSnapshot = { id: 'w', title: 'w', version: '1', stages: [], nodes: [
    { id: 'review', kind: 'review', title: '修复代码评审', needs: [], review: { target: ['src/**'], author: 'dev', reviewers: [{ role: 'qa' }], maxRounds: 3, onExhausted: 'fail', pass: 'all' } },
  ] }
  await stores.runs.create(run, snapshot)
  const detail = await reviewDetail(stores, run.runId, 'review')
  expect(detail?.status).toBe('skipped')
  expect(detail?.facets?.phase).toBe('skipped')
})
