import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { initProject } from '../store/project.js'
import { createCommandRegistry } from '../commands/index.js'
import { createEngine } from './index.js'
import type { HarnessAdapter, NodeDef, WorkflowDefinition } from '../types.js'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'takt-retry-')); roots.push(root)
  const stores = await initProject(root)
  const requirementId = (await stores.workspaces.createRequirement({ title: '失败重试' })).id
  const run = vi.fn().mockRejectedValueOnce(new Error('第一次失败')).mockResolvedValue({ ok: true, finalText: '完成' })
  const mock: HarnessAdapter = { id: 'mock', displayName: 'mock', capabilities: {}, available: async () => ({ ok: true }), run }
  const deps = { stores, profiles: { worker: { role: 'worker', title: '执行', description: '', instructions: '', skills: [], writeScope: [], harness: { harness: 'mock' } } }, harnesses: { mock }, knowledge: [] }
  const actor = { type: 'human', id: 'tester' } as const
  const engine = createEngine(deps, { actor })
  const before = vi.fn(), after = vi.fn()
  const nodes: NodeDef[] = [
    { id: 'before', kind: 'script', title: '完成节点', run: before },
    { id: 'work', kind: 'agent', title: '失败节点', role: 'worker', harness: { harness: 'mock' }, prompt: '执行', needs: ['before'] },
    { id: 'after', kind: 'script', title: '下游', run: after, needs: ['work'] },
  ]
  const workflow: WorkflowDefinition = { id: 'retry', title: '重试', version: '1', stages: [], nodes }
  return { stores, requirementId, run, deps, actor, engine, workflow, before, after }
}

it('命令重试只执行失败节点和下游，保留完成结果且事件链可验证', async () => {
  const f = await fixture()
  const first = await f.engine.start({ requirementId: f.requirementId, workflow: f.workflow })
  expect(first.status).toBe('failed')
  const audit = vi.fn(async () => {})
  const commands = createCommandRegistry({ stores: f.stores, audit,
    retryRun: (input, context) => createEngine(f.deps, { actor: context.actor }).retry(input.runId, f.workflow, { nodeIds: input.nodeIds, reason: context.reason }),
  })
  const input = { runId: first.runId }
  expect(await commands.run('run.retry', input, { actor: f.actor })).toMatchObject({ ok: false, message: '写操作必须说明原因' })
  expect(await commands.run('run.retry', input, { actor: f.actor, reason: '已修复引擎' })).toMatchObject({ ok: true, result: { status: 'succeeded' } })
  const result = (await f.stores.runs.get(first.runId))!
  expect(result.nodes.work).toMatchObject({ status: 'succeeded', attempts: 2 })
  expect(result.nodes.work!.error).toBeUndefined()
  expect(result.nodes.before).toEqual(first.nodes.before)
  expect(f.before).toHaveBeenCalledTimes(1)
  expect(f.run).toHaveBeenCalledTimes(2)
  expect(f.after).toHaveBeenCalledTimes(1)
  expect(await f.stores.events.read(first.runId, { types: ['run.retried'] })).toMatchObject([{ actor: f.actor, data: { nodeIds: ['work'], reason: '已修复引擎' } }])
  expect(await f.stores.events.verify(first.runId)).toEqual({ ok: true })
})

it.each(['failed', 'running', 'waiting_human'] as const)('%s 可重试 blocked，恢复跳过或取消的下游，其他失败节点保持原状', async status => {
  const f = await fixture()
  const state = await f.engine.start({ requirementId: f.requirementId, workflow: f.workflow })
  f.workflow.nodes.push({ id: 'later', kind: 'script', title: '传递下游', needs: ['after'], run: async () => {} },
    { id: 'other', kind: 'script', title: '其他失败', run: async () => { throw new Error('不应执行') } })
  state.status = status
  state.nodes.work!.status = 'blocked'
  state.nodes.after!.status = 'skipped'
  state.nodes.later = { id: 'later', status: 'cancelled', attempts: 0, outputs: [] }
  state.nodes.other = { id: 'other', status: 'failed', attempts: 1, outputs: [], error: '独立失败' }
  await f.stores.runs.save(state)
  const onStarted = vi.fn(() => { throw new Error('回执异常不影响运行') })
  const result = await f.engine.retry(state.runId, f.workflow, { nodeIds: ['work'], onStarted })
  expect(result.status).toBe('failed')
  expect(result.nodes.work!.status).toBe('succeeded')
  expect(result.nodes.after!.status).toBe('succeeded')
  expect(result.nodes.later!.status).toBe('succeeded')
  expect(result.nodes.other).toEqual(state.nodes.other)
  expect(onStarted).toHaveBeenCalledTimes(1)
})

it('非法节点、无失败节点、成功或取消运行、错误 workflow 和活租约均在启动前拒绝', async () => {
  const f = await fixture()
  const state = await f.engine.start({ requirementId: f.requirementId, workflow: f.workflow })
  const onStarted = vi.fn()
  await expect(f.engine.retry(state.runId, f.workflow, { nodeIds: ['before', 'missing'], onStarted })).rejects.toThrow('before、missing')
  await expect(f.engine.retry(state.runId, f.workflow, { nodeIds: [], onStarted })).rejects.toThrow('没有失败或阻塞的节点可以重试')
  await expect(f.engine.retry(state.runId, { ...f.workflow, version: '2' }, { onStarted })).rejects.toThrow('不匹配')
  const lease = join(f.stores.taktDir, 'runs', state.runId, 'lease.json')
  await writeFile(lease, JSON.stringify({ pid: process.pid, host: hostname(), startedAt: state.startedAt }))
  await expect(f.engine.retry(state.runId, f.workflow, { onStarted })).rejects.toThrow('运行正在由进程')
  await rm(lease)
  expect(await f.stores.runs.get(state.runId)).toEqual(state)
  for (const status of ['succeeded', 'cancelled'] as const) {
    state.status = status
    await f.stores.runs.save(state)
    await expect(f.engine.retry(state.runId, f.workflow, { onStarted })).rejects.toThrow('已成功或已取消的运行不能重试')
  }
  expect(onStarted).not.toHaveBeenCalled()
  expect(await f.stores.events.read(state.runId, { types: ['run.retried'] })).toEqual([])
  const empty = await fixture()
  empty.workflow.nodes = [{ id: 'wait', kind: 'human', title: '等人', ask: '确认', form: 'approve' }]
  const waiting = await empty.engine.start({ requirementId: empty.requirementId, workflow: empty.workflow })
  await expect(empty.engine.retry(waiting.runId, empty.workflow)).rejects.toThrow('没有失败或阻塞的节点可以重试')
})

it('指定容器内失败节点时重新进入父调度，不重做已完成兄弟节点', async () => {
  const f = await fixture()
  const sibling = vi.fn()
  f.workflow.nodes = [{ id: 'loop', kind: 'loop', title: '容器', maxIterations: 1, until: async () => true, body: [
    { id: 'done', kind: 'script', title: '已完成', run: sibling },
    { id: 'work', kind: 'agent', title: '执行', role: 'worker', prompt: '执行', needs: ['done'] },
  ] }]
  const first = await f.engine.start({ requirementId: f.requirementId, workflow: f.workflow })
  expect(first.nodes['loop/work']!.status).toBe('failed')
  const result = await f.engine.retry(first.runId, f.workflow, { nodeIds: ['loop/work'] })
  expect(result.status).toBe('succeeded')
  expect(result.nodes['loop/done']).toEqual(first.nodes['loop/done'])
  expect(sibling).toHaveBeenCalledTimes(1)
  expect(result.nodes['loop/work']!.attempts).toBe(2)
})

it('重试重复失败而 blocked 的节点会关闭旧待办，保留其他待办', async () => {
  const f = await fixture()
  f.stores.config.retry = { maxSameFailure: 1 }
  f.workflow.nodes.push({ id: 'wait', kind: 'human', title: '独立待办', ask: '确认', form: 'approve' })
  const first = await f.engine.start({ requirementId: f.requirementId, workflow: f.workflow })
  expect(first.nodes.work!.status).toBe('blocked')
  expect(await f.stores.attention.list({ pending: true })).toHaveLength(2)
  const state = await f.engine.retry(first.runId, f.workflow)
  expect(state.status).toBe('waiting_human')
  expect(state.nodes.work!.status).toBe('succeeded')
  expect(await f.stores.attention.list({ pending: true })).toMatchObject([{ nodeId: 'wait' }])
  expect((await f.stores.attention.list()).find(item => item.nodeId === 'work')).toMatchObject({ decision: 'cancelled', answeredBy: f.actor })
})
