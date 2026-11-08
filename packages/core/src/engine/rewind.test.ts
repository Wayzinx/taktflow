import { mkdtemp, mkdir, rm, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { initProject } from '../store/project.js'
import { snapshotWorkflow } from '../store/snapshot.js'
import { createEngine } from './index.js'
import { previewRewind, rewind, RewindConflictError } from './rewind.js'
import { captureNodeChanges, captureRewindPoint, nodeChanges, repoManager, rewindGit } from '../insights/changes.js'
import { nodeDiff } from '../insights/node-diff.js'
import type { RunState, WorkflowDefinition } from '../types.js'
const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
const actor = { type: 'human', id: 'tester' } as const
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'takt-rewind-')); roots.push(root)
  const stores = await initProject(root), req = await stores.workspaces.createRequirement({ title: '回退测试' })
  return { root, stores, req }
}
it('真实 runtime 记录回退点，预览与回退新增版本并使下游过期，历史版本保留', async () => {
  const { stores, req } = await setup()
  await stores.workspaces.writeArtifact({ ref: { workspace: req.id, path: 'a.txt' }, content: 'before\n', kind: 'other', author: actor, reason: '初始' })
  const workflow: WorkflowDefinition = { id: 'w', title: 'w', version: '1', stages: [], nodes: [
    { id: 'edit', kind: 'script', outputs: [{ path: 'a.txt', kind: 'other' }], run: async ctx => { await writeFile(join(ctx.workspaceDir, 'a.txt'), 'after\n') } },
    { id: 'next', kind: 'script', needs: ['edit'], inputs: [{ path: 'a.txt' }], run: async () => {} },
  ] }
  const engine = createEngine({ stores, profiles: {}, harnesses: {}, knowledge: [] })
  const state = await engine.start({ workflow, requirementId: req.id })
  expect(state.status).toBe('succeeded')
  const changes = await nodeChanges(stores, state.runId, 'edit')
  expect(changes.files).toEqual([{ path: 'a.txt', scope: 'workspace', status: 'modified', from: 1, to: 2, add: 1, del: 1 }])
  expect((await nodeDiff(stores, state.runId, 'edit', 'a.txt')).patch).toContain('-before\n+after')
  await expect(nodeDiff(stores, state.runId, 'edit', '../secret')).rejects.toThrow()
  await expect(nodeDiff(stores, state.runId, 'edit', 'absent.txt')).rejects.toThrow('不在节点改动')
  const preview = await previewRewind(stores, state.runId, 'edit')
  expect(preview.blocked).toBeUndefined()
  expect(preview.stale.map(item => item.nodeId)).toEqual(['edit', 'next'])
  await expect(rewind(stores, state.runId, 'edit', { token: preview.token, reason: '' }, actor)).rejects.toThrow('原因')
  const result = await rewind(stores, state.runId, 'edit', { token: preview.token, reason: '重新实现' }, actor)
  expect(result.files[0]?.version).toBe(3)
  expect((await stores.workspaces.readArtifact({ workspace: req.id, path: 'a.txt' }))!.toString()).toBe('before\n')
  expect((await stores.workspaces.listArtifacts(req.id))[0]!.versions).toHaveLength(3)
  expect((await stores.runs.get(state.runId))!.nodes.next!.status).toBe('stale')
  expect((await stores.events.read(state.runId)).at(-1)!.type).toBe('node.rewound')
  expect(await stores.events.verify(state.runId)).toEqual({ ok: true })
  await expect(rewind(stores, state.runId, 'edit', { token: preview.token, reason: '重复' }, actor)).rejects.toBeInstanceOf(RewindConflictError)
})
it('存放区外部改动、运行中下游、非法路径与旧数据 fail closed', async () => {
  const { stores, req } = await setup()
  const workflow: WorkflowDefinition = { id: 'w', title: 'w', version: '1', stages: [], nodes: [{ id: 'n', kind: 'script', run: async () => {} }, { id: 'after', kind: 'script', needs: ['n'], run: async () => {} }] }
  const state: RunState = { runId: 'r', requirementId: req.id, workflowId: 'w', workflowVersion: '1', startedAt: new Date().toISOString(), status: 'succeeded', args: {}, expansions: [], nodes: { n: { id: 'n', status: 'succeeded', attempts: 1, outputs: [] }, after: { id: 'after', status: 'running', attempts: 1, outputs: [] } } }
  await stores.runs.create(state, snapshotWorkflow(workflow))
  expect((await nodeChanges(stores, 'r', 'n')).rewindBlocked).toContain('没有回退点')
  expect((await previewRewind(stores, 'r', 'n')).blocked).toContain('下游正在运行')
  await expect(previewRewind(stores, '../r', 'n')).rejects.toThrow()
  await expect(previewRewind(stores, 'r', '../n')).rejects.toThrow()
})
it('临时 git 仓库只恢复节点路径，预览后工作树改变导致 token 冲突', async () => {
  const { root, stores, req } = await setup()
  const repo = join(root, 'repo'); await mkdir(repo)
  await rewindGit(repo, ['init', '-b', 'main'])
  await rewindGit(repo, ['config', 'user.email', 'test@example.invalid']); await rewindGit(repo, ['config', 'user.name', 'test'])
  await writeFile(join(repo, 'a.txt'), 'before\n'); await writeFile(join(repo, 'keep.txt'), 'keep\n')
  await rewindGit(repo, ['add', '.']); await rewindGit(repo, ['commit', '-m', 'fixture'])
  stores.config.repos = [{ id: 'app', path: 'repo', defaultBranch: 'main' }]
  const manager = await repoManager(stores), tree = await manager.createWorktree({ repoId: 'app', runId: 'r', nodeId: 'n' })
  const node = { id: 'n', kind: 'script' as const, run: 'true' }
  const state: RunState = { runId: 'r', requirementId: req.id, workflowId: 'w', workflowVersion: '1', startedAt: new Date().toISOString(), status: 'succeeded', args: {}, expansions: [], nodes: { n: { id: 'n', status: 'succeeded', attempts: 1, outputs: [], worktree: { ...tree, repo: 'app' } } } }
  await stores.runs.create(state, snapshotWorkflow({ id: 'w', title: 'w', version: '1', stages: [], nodes: [node] }))
  const point = await captureRewindPoint(stores, state, node, state.nodes.n!)
  await stores.events.append('r', { type: 'node.started', actor, nodeId: 'n', data: { attempt: 1, rewindPoint: point } })
  await writeFile(join(tree.path, 'a.txt'), 'after\n'); await writeFile(join(tree.path, 'new.txt'), 'new\n')
  await captureNodeChanges(stores, state, 'n', manager)
  const preview = await previewRewind(stores, 'r', 'n')
  expect(preview.blocked).toBeUndefined()
  expect(preview.files).toHaveLength(2)
  const frozen = await nodeDiff(stores, 'r', 'n')
  expect(frozen.patch).toContain('-before\n+after')
  expect(frozen.patch).toContain('+new')
  await writeFile(join(tree.path, 'keep.txt'), 'external\n')
  expect(await nodeDiff(stores, 'r', 'n')).toEqual(frozen)
  expect((await previewRewind(stores, 'r', 'n')).blocked).toContain('工作树')
  await expect(rewind(stores, 'r', 'n', { token: preview.token, reason: '重做' }, actor)).rejects.toBeInstanceOf(RewindConflictError)
  await writeFile(join(tree.path, 'keep.txt'), 'keep\n')
  const fresh = await previewRewind(stores, 'r', 'n')
  await rewind(stores, 'r', 'n', { token: fresh.token, reason: '重做' }, actor)
  expect(await readFile(join(tree.path, 'a.txt'), 'utf8')).toBe('before\n')
  expect(await readFile(join(tree.path, 'keep.txt'), 'utf8')).toBe('keep\n')
  await expect(readFile(join(tree.path, 'new.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
  expect((await stores.runs.get('r'))!.nodes.n!.status).toBe('stale')
  const dirtyPoint = await captureRewindPoint(stores, state, node, state.nodes.n!)
  // 恢复之后模拟下一次开始时已有外部未提交改动。
  await writeFile(join(tree.path, 'keep.txt'), 'dirty before node\n')
  const dirty = await captureRewindPoint(stores, state, node, state.nodes.n!)
  expect(dirty.repos).toEqual(dirtyPoint.repos)
  await stores.events.append('r', { type: 'node.started', actor, nodeId: 'n', data: { attempt: 1, rewindPoint: dirty } })
  await captureNodeChanges(stores, state, 'n', manager)
  const blocked = await previewRewind(stores, 'r', 'n')
  expect(blocked.blocked).toContain('开始前工作树已有外部改动')
  await expect(rewind(stores, 'r', 'n', { token: blocked.token, reason: '不应恢复' }, actor)).rejects.toThrow('开始前工作树已有外部改动')
  expect(await readFile(join(tree.path, 'keep.txt'), 'utf8')).toBe('dirty before node\n')
})
it('新增产物保留原样、生产节点及下游过期，重跑覆盖；外部删除仍使 token 失效', async () => {
  const { stores, req } = await setup()
  await stores.workspaces.writeArtifact({ ref: { workspace: req.id, path: 'exists.txt' }, content: 'before', kind: 'other', author: actor, reason: '初始' })
  const workflow: WorkflowDefinition = { id: 'w', title: 'w', version: '1', stages: [], nodes: [
    { id: 'exists', kind: 'script', outputs: [{ path: 'exists.txt', kind: 'other' }], run: async ctx => { await writeFile(join(ctx.workspaceDir, 'exists.txt'), 'after') } },
    { id: 'add', kind: 'script', outputs: [{ path: 'new.txt', kind: 'other' }], run: async ctx => { await writeFile(join(ctx.workspaceDir, 'new.txt'), 'new') } },
    { id: 'consumer', kind: 'script', needs: ['add'], inputs: [{ path: 'new.txt' }], run: async () => {} },
  ] }
  const state = await createEngine({ stores, profiles: {}, harnesses: {}, knowledge: [] }).start({ workflow, requirementId: req.id })
  expect(state.status).toBe('succeeded')
  const other = await createEngine({ stores, profiles: {}, harnesses: {}, knowledge: [] }).start({ requirementId: req.id,
    workflow: { id: 'other', title: 'other', version: '1', stages: [], nodes: [{ id: 'reader', kind: 'script', inputs: [{ path: 'new.txt' }], run: async () => {} }] } })
  const added = await previewRewind(stores, state.runId, 'add')
  expect(added.blocked).toBeUndefined()
  expect(added.files[0]).toMatchObject({ path: 'new.txt', to: 1 })
  expect(added.files[0]!.from).toBeUndefined()
  const rewound = await rewind(stores, state.runId, 'add', { token: added.token, reason: '重做新增产物' }, actor)
  expect(rewound.files[0]).toMatchObject({ path: 'new.txt', version: undefined })
  expect((await stores.workspaces.listArtifacts(req.id)).find(item => item.path === 'new.txt')!.versions).toHaveLength(1)
  expect((await stores.workspaces.readArtifact({ workspace: req.id, path: 'new.txt' }))!.toString()).toBe('new')
  expect((await stores.runs.get(state.runId))!.nodes.add!.status).toBe('stale')
  expect((await stores.runs.get(state.runId))!.nodes.consumer!.status).toBe('stale')
  expect((await stores.runs.get(other.runId))!.nodes.reader!.status).toBe('stale')
  expect((await stores.events.read(state.runId, { types: ['node.rewound'] }))[0]!.data).toMatchObject({ kept: ['new.txt'], files: [{ path: 'new.txt', scope: 'workspace' }] })
  workflow.nodes[1] = { id: 'add', kind: 'script', outputs: [{ path: 'new.txt', kind: 'other' }], run: async ctx => { await writeFile(join(ctx.workspaceDir, 'new.txt'), 'rerun') } }
  const resumed = await createEngine({ stores, profiles: {}, harnesses: {}, knowledge: [] }).resume(state.runId, workflow)
  expect(resumed.status).toBe('succeeded')
  expect((await stores.workspaces.readArtifact({ workspace: req.id, path: 'new.txt' }))!.toString()).toBe('rerun')
  const preview = await previewRewind(stores, state.runId, 'exists')
  expect(preview.blocked).toBeUndefined()
  await rm(join(stores.workspaces.dir(req.id), 'exists.txt'))
  expect((await previewRewind(stores, state.runId, 'exists')).blocked).toContain('删除')
  await expect(rewind(stores, state.runId, 'exists', { token: preview.token, reason: '回退' }, actor)).rejects.toBeInstanceOf(RewindConflictError)
})
it('条件为假的仓库节点不创建工作树或要求仓库执行面', async () => {
  const { stores, req } = await setup()
  const workflow: WorkflowDefinition = { id: 'skip', title: 'skip', version: '1', stages: [], nodes: [{ id: 'skip', kind: 'agent', role: 'dev', repo: 'missing', prompt: '', when: () => false }] }
  const engine = createEngine({ stores, profiles: { dev: { role: 'dev', title: 'dev', description: '', instructions: '', skills: [], writeScope: [], harness: { harness: 'stub' } } },
    harnesses: { stub: { id: 'stub', displayName: 'stub', available: async () => ({ ok: true }), run: async () => { throw new Error('不应调用') } } }, knowledge: [] })
  const state = await engine.start({ workflow, requirementId: req.id })
  expect(state.nodes.skip!.status).toBe('skipped')
  expect((await stores.events.read(state.runId)).some(event => event.type === 'worktree.created')).toBe(false)
})
