import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { hostname, tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, expect, it, vi } from 'vitest'
import { defineWorkflow, human, script } from '../dsl.js'
import { fileURLToPath } from 'node:url'
import { matchGlob } from '../util/glob.js'
import { loadProfiles, initProject } from '../store/project.js'
import { snapshotWorkflow } from '../store/snapshot.js'
import type { RunState } from '../types.js'
import { createEngine } from './index.js'
import { runLiveness } from './lease.js'

const roots: string[] = []
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'takt-lease-')); roots.push(root)
  const stores = await initProject(root)
  const req = await stores.workspaces.createRequirement({ title: '恢复运行' })
  const deps = { stores, profiles: {}, harnesses: {}, knowledge: [] }
  const lease = (runId: string) => join(stores.taktDir, 'runs', runId, 'lease.json')
  return { stores, deps, requirementId: req.id, lease }
}
const workflow = (nodes: Parameters<typeof defineWorkflow>[0]['nodes']) => defineWorkflow({ id: 'recover', title: '恢复', version: '1', stages: [], nodes })

it('start 全程持有租约，另一个引擎不能 resume；结束后删除', async () => {
  const { stores, deps, requirementId, lease } = await fixture()
  let release!: () => void, entered!: (id: string) => void
  const wait = new Promise<void>(resolve => { release = resolve })
  const ready = new Promise<string>(resolve => { entered = resolve })
  const run = vi.fn(async (ctx: {runId: string}) => { entered(ctx.runId); await wait })
  const def = workflow([script({ id: 'hold', title: '等待', run })])
  const pending = createEngine(deps).start({ workflow: def, requirementId })
  const id = await ready
  try {
    expect(JSON.parse(await readFile(lease(id), 'utf8'))).toMatchObject({ pid: process.pid, host: hostname(), startedAt: expect.any(String) })
    expect(await runLiveness(stores, id)).toBe('active')
    await expect(createEngine(deps).resume(id, def)).rejects.toThrow(`运行正在由进程 ${process.pid} 执行`)
    expect(run).toHaveBeenCalledTimes(1)
  } finally { release(); await pending }
  expect(await runLiveness(stores, id)).toBe('idle')
  await expect(readFile(lease(id))).rejects.toMatchObject({ code: 'ENOENT' })
})

it('running 节点和死租约可恢复，已完成节点不重复执行', async () => {
  const { stores, deps, requirementId, lease } = await fixture()
  const done = vi.fn(), next = vi.fn()
  const def = workflow([script({ id: 'done', title: '已完成', run: done }), script({ id: 'next', title: '继续', needs: ['done'], run: next })])
  const state: RunState = { runId: 'crashed', workflowId: def.id, workflowVersion: def.version, requirementId, status: 'running', startedAt: new Date().toISOString(), args: {}, expansions: [], nodes: {
    done: { id: 'done', status: 'succeeded', attempts: 1, outputs: [] }, next: { id: 'next', status: 'running', attempts: 1, outputs: [] },
  } }
  await stores.runs.create(state, snapshotWorkflow(def))
  expect(await runLiveness(stores, state.runId)).toBe('interrupted')
  const { stdout } = await promisify(execFile)(process.execPath, ['-e', 'console.log(process.pid)'])
  await writeFile(lease(state.runId), JSON.stringify({ pid: Number(stdout.trim()), host: hostname(), startedAt: state.startedAt }))
  expect(await runLiveness(stores, state.runId)).toBe('interrupted')
  expect((await createEngine(deps).resume(state.runId, def)).status).toBe('succeeded')
  expect(done).not.toHaveBeenCalled(); expect(next).toHaveBeenCalledTimes(1)
  await expect(readFile(lease(state.runId))).rejects.toMatchObject({ code: 'ENOENT' })
})

it.each(['waiting_human', 'failed', 'cancelled'] as const)('%s 退出也释放租约', async status => {
  const { deps, requirementId, lease } = await fixture()
  const engine = createEngine(deps)
  const def = workflow(status === 'waiting_human' ? [human({ id: 'ask', title: '确认', ask: '继续？', form: 'approve' })] : [script({ id: 'work', title: '执行', run: async ctx => {
    if (status === 'failed') throw new Error('测试失败')
    await engine.cancel(ctx.runId)
  } })])
  const state = await engine.start({ workflow: def, requirementId })
  expect(state.status).toBe(status)
  await expect(readFile(lease(state.runId))).rejects.toMatchObject({ code: 'ENOENT' })
})

it('创建后的异常清理租约；非 running 不读取租约', async () => {
  const { stores, deps, requirementId, lease } = await fixture()
  let id = ''
  vi.spyOn(stores.runs, 'create').mockImplementation(async state => { id = state.runId; throw new Error('写入失败') })
  await expect(createEngine(deps).start({ workflow: workflow([]), requirementId })).rejects.toThrow('写入失败')
  await expect(readFile(lease(id))).rejects.toMatchObject({ code: 'ENOENT' })
  const get = vi.spyOn(stores.runs, 'get')
  expect(await runLiveness(stores, '../invalid', { status: 'succeeded' })).toBe('idle')
  expect(get).not.toHaveBeenCalled()
})


it('内置及演示角色的写范围不覆盖租约，运行元数据不算业务产物', async () => {
  const { stores, requirementId, lease, deps } = await fixture()
  for (const base of ['../../../../templates/', '../../../../examples/standard-delivery/']) {
    const profiles = await loadProfiles(fileURLToPath(new URL(base, import.meta.url)))
    expect(Object.keys(profiles).length).toBeGreaterThan(0)
    for (const profile of Object.values(profiles)) {
      expect(profile.writeScope.some(pattern => matchGlob(pattern, '.takt/runs/run-1/lease.json')), profile.role).toBe(false)
    }
  }
  const { WriteGuard } = await import('./guard.js')
  const finish = await new WriteGuard(stores.projectDir, relative(stores.projectDir, stores.paths.requirements)).begin({ profile: [] })
  const state = await createEngine(deps).start({ requirementId, workflow: workflow([]) })
  await expect(readFile(lease(state.runId))).rejects.toMatchObject({ code: 'ENOENT' })
  expect((await finish()).paths).toEqual([])
})
