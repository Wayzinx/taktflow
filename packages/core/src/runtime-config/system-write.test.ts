import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { WriteGuard, systemWrite } from '../engine/guard.js'
import { createEngine } from '../engine/index.js'
import { initProject } from '../store/project.js'
import { patchRuntimeConfig, runtimeRevision } from './index.js'

const dirs: string[] = []
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))) })
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'takt-system-write-')); dirs.push(root)
  const stores = await initProject(root)
  const guard = new WriteGuard(root)
  const save = () => patchRuntimeConfig(stores, { baseRevision: runtimeRevision(stores.config), reason: '运行期间修改', roles: { dev: { harness: 'mock' } } },
    { type: 'human', id: 'owner' }, { builtinHarnesses: ['mock'] })
  return { root, stores, guard, save, file: join(root, 'takt.config.json') }
}

it('补丁对同根所有守卫开窗；配置、审计及锁不误报，不豁免其他文件', async () => {
  const f = await fixture()
  const other = new WriteGuard(join(f.root, '.'))
  const finish = await f.guard.begin({ profile: [] }), finishOther = await other.begin({ profile: [] })
  await f.save()
  await writeFile(join(f.root, 'agent.txt'), 'agent')
  expect((await finish()).paths).toEqual(['agent.txt'])
  expect((await finishOther()).paths).toEqual(['agent.txt'])
  expect(await readFile(join(f.root, '.takt/space-events.jsonl'), 'utf8')).toContain('roles.dev')
})

it.each(['before', 'after', 'between'] as const)('同一个节点期间 agent 在受控补丁 %s 写配置仍标越界', async when => {
  const f = await fixture(), finish = await f.guard.begin({ profile: [] })
  if (when !== 'before') await f.save()
  const config = JSON.parse(await readFile(f.file, 'utf8'))
  config.project.name = 'agent 修改'
  await writeFile(f.file, JSON.stringify(config))
  if (when !== 'after') await f.save()
  expect((await finish()).paths).toEqual(['takt.config.json'])
})

it('窗口关闭后新节点直接改配置仍被标出；另一个根目录不受豁免', async () => {
  const f = await fixture(), other = await fixture()
  await f.save()
  const finish = await f.guard.begin({ profile: [] }), finishOther = await other.guard.begin({ profile: [] })
  await systemWrite(f.root, ['takt.config.json'], async () => {
    await writeFile(other.file, '{}')
  })
  await writeFile(f.file, '{}')
  expect((await finish()).paths).toEqual(['takt.config.json'])
  expect((await finishOther()).paths).toEqual(['takt.config.json'])
})

it('异常退出关闭系统窗口，受控部分保留归因，后续直接写仍报告', async () => {
  const f = await fixture(), finish = await f.guard.begin({ profile: [] })
  await expect(systemWrite(f.root, ['takt.config.json'], async () => {
    await writeFile(f.file, '{"system":true}')
    throw new Error('写入后失败')
  })).rejects.toThrow('写入后失败')
  expect((await finish()).paths).toEqual([])
  const later = await f.guard.begin({ profile: [] })
  await writeFile(f.file, '{}')
  expect((await later()).paths).toEqual(['takt.config.json'])
})

it('并发补丁串行记账；一个产物窗口结束不会丢掉另一个节点的系统记录', async () => {
  const f = await fixture(), finish = await f.guard.begin({ profile: [] })
  const outputs = await f.guard.watchOutputs(f.stores.paths.requirements, [])
  const outcomes = await Promise.allSettled([f.save(), f.save()])
  expect(outcomes.filter(outcome => outcome.status === 'fulfilled')).toHaveLength(1)
  expect(outcomes.find(outcome => outcome.status === 'rejected')).toMatchObject({ reason: { status: 409 } })
  await outputs()
  expect((await finish()).paths).toEqual([])
})

it.each([false, true])('真实 engine 节点执行时保存补丁；agent 直接改配置=%s', async agentWrites => {
  const f = await fixture()
  const req = await f.stores.workspaces.createRequirement({ title: '配置写入守卫' })
  let started!: () => void, release!: () => void
  const entered = new Promise<void>(resolve => { started = resolve })
  const pending = new Promise<void>(resolve => { release = resolve })
  const engine = createEngine({ stores: f.stores, knowledge: [], profiles: {
    dev: { role: 'dev', title: '开发', description: '', instructions: '', skills: [], writeScope: [], harness: { harness: 'mock' } },
  }, harnesses: { mock: { id: 'mock', displayName: 'mock', available: async () => ({ ok: true }), run: async () => {
    started(); await pending
    if (agentWrites) await writeFile(f.file, '{}')
    return { ok: true, finalText: 'done' }
  } } } })
  const running = engine.start({ requirementId: req.id, workflow: { id: 'guard', title: 'guard', version: '1', stages: [], nodes: [
    { id: 'dev', kind: 'agent', title: 'dev', role: 'dev', prompt: 'wait' },
  ] } })
  await entered
  try { await f.save() } finally { release() }
  const state = await running
  const violations = await f.stores.events.read(state.runId, { types: ['guard.violation'] })
  if (agentWrites) {
    expect(state.nodes.dev?.status).toBe('blocked')
    expect(violations).toEqual([expect.objectContaining({ data: expect.objectContaining({ paths: ['takt.config.json'] }) })])
  } else {
    expect(state.status).toBe('succeeded')
    expect(violations).toEqual([])
  }
})
