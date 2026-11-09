import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { defineWorkflow, human, script } from '../dsl.js'
import { initProject, openProject } from '../store/project.js'
import type { Actor, AgentProfile, HarnessAdapter, NodeDef, TaktConfig } from '../types.js'
import { hasEnvironmentTeardown, teardownEnvironment } from './environment.js'
import { createEngine } from './index.js'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))) })

// 测试夹具的合成回答者，不是真实用户。
const qaFixture: Actor = { type: 'human', id: 'qa-fixture' }
const count = async (root: string, path: string) => (await readFile(join(root, path), 'utf8')).trim().split('\n').length

function teardownNode(): NodeDef {
  return script({ id: 'env-teardown', title: '回收被测环境', needs: ['fail'], when: hasEnvironmentTeardown, run: teardownEnvironment })
}

async function fixture(environment: TaktConfig['environment'], withHuman = true) {
  const root = await mkdtemp(join(tmpdir(), 'takt-environment-cleanup-'))
  roots.push(root)
  const stores = await initProject(root, { layout: 'legacy' })
  if (environment) {
    stores.config.environment = environment
    await writeFile(join(root, 'takt.config.json'), JSON.stringify(stores.config))
  }
  const requirementId = (await stores.workspaces.createRequirement({ title: '恢复后终态' })).id
  const harness: HarnessAdapter = { id: 'mock', displayName: '不应调用模型', available: async () => ({ ok: true }), run: async () => { throw new Error('不应调用 harness') } }
  const deps = { stores, profiles: {} as Record<string, AgentProfile>, harnesses: { mock: harness }, knowledge: [] }
  const workflow = defineWorkflow({
    id: 'environment-cleanup', title: '恢复后终态', version: '1', stages: [], nodes: [
      ...(withHuman ? [human({ id: 'answer', title: '澄清', form: 'answer', ask: '确认执行范围（测试夹具）' })] : []),
      script({ id: 'fail', title: '实现', ...(withHuman ? { needs: ['answer'] } : {}), run: async () => { throw new Error('expected fail after resume') } }),
      teardownNode(),
    ],
  })
  return { root, stores, requirementId, deps, workflow, engine: createEngine(deps) }
}

async function pauseAndAnswer(f: Awaited<ReturnType<typeof fixture>>) {
  const paused = await f.engine.start({ workflow: f.workflow, requirementId: f.requirementId })
  expect(paused.status).toBe('waiting_human')
  const [item] = await f.stores.attention.list({ pending: true })
  expect(item).toMatchObject({ nodeId: 'answer', form: 'answer' })
  await f.stores.attention.answer(item!.requestId, { decision: 'answer', answer: 'test fixture answer', by: qaFixture })
  return paused
}

it('人工回答后恢复并失败：返回值、落盘终态与终止事件一致，未配置环境时回收只尝试一次且 skipped', async () => {
  const f = await fixture(undefined)
  const paused = await pauseAndAnswer(f)

  // 换一个项目实例恢复，走真实的 FsRunStore.get -> Runtime.save -> finalizeEnvironment 路径。
  const reopened = await openProject(f.root)
  const finished = await createEngine({ ...f.deps, stores: reopened }).resume(paused.runId, f.workflow)
  expect(finished.status).toBe('failed')
  expect(finished.endedAt).toBeDefined()
  expect(finished.nodes['env-teardown']).toMatchObject({ status: 'skipped', attempts: 1 })

  const persisted = await reopened.runs.get(paused.runId)
  expect(persisted?.status).toBe('failed')
  expect(persisted?.endedAt).toBeDefined()
  expect(persisted?.nodes['env-teardown']).toMatchObject({ status: 'skipped', attempts: 1 })
  expect(persisted?.nodes['env-teardown']?.endedAt).toBeDefined()

  const events = await reopened.events.read(paused.runId)
  expect(events.filter((event) => event.type === 'run.finished').at(-1)?.data).toEqual({ status: 'failed' })
  const cleanup = events.filter((event) => event.type === 'node.finished' && event.nodeId === 'env-teardown')
  expect(cleanup).toHaveLength(1)
  expect(cleanup[0]?.data).toMatchObject({ status: 'skipped' })
  expect(await reopened.events.verify(paused.runId)).toEqual({ ok: true })
})

it.each([
  { outcome: '成功', teardown: 'echo teardown >> teardown-count', log: '环境回收完成' },
  { outcome: '失败', teardown: 'echo teardown >> teardown-count; exit 9', log: '环境回收失败（仅记录）' },
])('配置回收命令$outcome：恢复后失败只回收一次，回收结论不改写终态', async ({ teardown, log }) => {
  const f = await fixture({ deploy: 'true', teardown })
  const paused = await pauseAndAnswer(f)

  const reopened = await openProject(f.root)
  const finished = await createEngine({ ...f.deps, stores: reopened }).resume(paused.runId, f.workflow)
  expect(finished.status).toBe('failed')

  const persisted = await reopened.runs.get(paused.runId)
  expect(persisted?.status).toBe('failed')
  expect(persisted?.nodes['env-teardown']).toMatchObject({ status: 'succeeded', attempts: 1 })
  expect(await count(f.root, 'teardown-count')).toBe(1)

  const events = await reopened.events.read(paused.runId)
  expect(events.filter((event) => event.type === 'run.finished').at(-1)?.data).toEqual({ status: 'failed' })
  const logs = events.filter((event) => event.type === 'log' && event.nodeId === 'env-teardown').map((event) => event.data.message).join('\n')
  expect(logs).toContain(log)
})

it('非恢复路径失败同样落盘 failed，回收节点仍按未配置 skipped', async () => {
  const f = await fixture(undefined, false)
  const finished = await f.engine.start({ workflow: f.workflow, requirementId: f.requirementId })
  expect(finished.status).toBe('failed')

  const persisted = await f.stores.runs.get(finished.runId)
  expect(persisted?.status).toBe('failed')
  expect(persisted?.nodes['env-teardown']).toMatchObject({ status: 'skipped', attempts: 1 })
})
