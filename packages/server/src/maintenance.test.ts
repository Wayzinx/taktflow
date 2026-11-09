import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { initProject, type EventEnvelope, type RunState } from '@taktflow/core'
import { startMaintenance } from './maintenance.js'

const roots: string[] = []
const workers: ReturnType<typeof startMaintenance>[] = []
beforeEach(() => { vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] }) })
afterEach(async () => {
  await Promise.all(workers.splice(0).map(worker => worker.close()))
  vi.useRealTimers(); vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function setup(status: RunState['status']) {
  const root = await mkdtemp(join(tmpdir(), 'takt-maintenance-')); roots.push(root)
  const stores = await initProject(root)
  const req = await stores.workspaces.createRequirement({ title: '维护同步' })
  const state: RunState = { runId: 'run-maintenance', requirementId: req.id, workflowId: 'test', workflowVersion: '1',
    status, startedAt: new Date().toISOString(), args: {}, nodes: {}, expansions: [] }
  await stores.runs.create(state, { id: 'test', title: '测试', version: '1', nodes: [], stages: [] })
  let callback!: (event: EventEnvelope) => void
  const stop = vi.fn()
  const subscribe = vi.spyOn(stores.events, 'subscribe').mockImplementation((_id, onEvent) => { callback = onEvent; return stop })
  const sync = vi.spyOn(stores.quality!, 'sync')
  const errors = vi.fn()
  const start = (spaces = () => [stores]) => {
    const worker = startMaintenance(spaces, undefined, errors)
    workers.push(worker)
    return worker
  }
  const finish = async () => {
    state.status = 'succeeded'
    await stores.runs.save(state)
    const event = await stores.events.append(state.runId, { type: 'run.finished', actor: { type: 'system', id: 'test' }, data: { status: state.status } })
    callback(event)
  }
  const synced = async () => vi.waitFor(async () => { expect((await stores.quality!.status()).cursors[state.runId]).toBe(1) })
  return { stores, state, stop, subscribe, sync, errors, start, finish, synced }
}

it.each(['succeeded', 'failed', 'cancelled'] as const)('启动时 %s 运行只补同步，不挂订阅、不重复同步', async status => {
  const f = await setup(status)
  await f.stores.events.append(f.state.runId, { type: 'run.finished', actor: { type: 'system', id: 'test' }, data: { status } })
  f.start()
  await f.synced()
  expect(f.subscribe).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(3000)
  expect(f.sync).toHaveBeenCalledTimes(1)
  expect(f.errors).not.toHaveBeenCalled()
})

it('结束后的最终同步落盘之前不取消，成功后取消且不再重复同步', async () => {
  const f = await setup('running')
  f.start()
  await vi.waitFor(() => expect(f.sync).toHaveBeenCalledTimes(1))
  let release!: () => void
  const barrier = new Promise<void>(resolve => { release = resolve })
  f.sync.mockRestore()
  const actual = f.stores.quality!.sync.bind(f.stores.quality)
  const finalSync = vi.spyOn(f.stores.quality!, 'sync').mockImplementationOnce(async runId => { await barrier; return actual(runId) })
  try {
    await f.finish()
    await vi.waitFor(() => expect(finalSync).toHaveBeenCalledTimes(1))
    expect(f.stop).not.toHaveBeenCalled()
    release()
    await vi.waitFor(() => expect(f.stop).toHaveBeenCalledTimes(1))
    await f.synced()
    await vi.advanceTimersByTimeAsync(2000)
    expect(finalSync).toHaveBeenCalledTimes(1)
  } finally { release() }
})

it('先落终态、后写结束事件时仍保留订阅，最后事件不会漏掉', async () => {
  const f = await setup('running')
  f.start()
  await vi.waitFor(() => expect(f.subscribe).toHaveBeenCalledTimes(1))
  f.state.status = 'succeeded'
  await f.stores.runs.save(f.state)
  await vi.advanceTimersByTimeAsync(1000)
  await vi.waitFor(() => expect(f.sync).toHaveBeenCalled())
  expect(f.stop).not.toHaveBeenCalled()
  await f.finish()
  await vi.waitFor(() => expect(f.stop).toHaveBeenCalledTimes(1))
  await f.synced()
})

it('最终同步失败保留订阅，轮询重试成功后取消', async () => {
  const f = await setup('waiting_human')
  f.start()
  await vi.waitFor(() => expect(f.sync).toHaveBeenCalledTimes(1))
  f.sync.mockRejectedValueOnce(new Error('模拟同步失败'))
  await f.finish()
  await vi.waitFor(() => expect(f.errors).toHaveBeenCalledTimes(1))
  expect(f.stop).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(1000)
  await vi.waitFor(() => expect(f.stop).toHaveBeenCalledTimes(1))
  await f.synced()
})

it('结束事件在同步进行中到达，必须等排队的最后一批同步成功再取消', async () => {
  const f = await setup('running')
  f.start()
  await vi.waitFor(async () => expect((await f.stores.quality!.status()).importedM3).toBe(true))
  f.sync.mockRestore()
  const actual = f.stores.quality!.sync.bind(f.stores.quality)
  let releaseFirst!: () => void, releaseLast!: () => void
  const first = new Promise<void>(resolve => { releaseFirst = resolve })
  const last = new Promise<void>(resolve => { releaseLast = resolve })
  const sync = vi.spyOn(f.stores.quality!, 'sync')
    .mockImplementationOnce(async () => { await first; return { observations: 0, runs: 1 } })
    .mockImplementationOnce(async runId => { await last; return actual(runId) })
  try {
    f.state.status = 'succeeded'
    await f.stores.runs.save(f.state)
    await vi.advanceTimersByTimeAsync(1000)
    await vi.waitFor(() => expect(sync).toHaveBeenCalledTimes(1))
    await f.finish()
    releaseFirst()
    await vi.waitFor(() => expect(sync).toHaveBeenCalledTimes(2))
    expect(f.stop).not.toHaveBeenCalled()
    releaseLast()
    await vi.waitFor(() => expect(f.stop).toHaveBeenCalledTimes(1))
    await f.synced()
  } finally { releaseFirst(); releaseLast() }
})

it('启动补同步失败的历史运行仍可重试，卸载再加载会重新补同步', async () => {
  const f = await setup('failed')
  await f.stores.events.append(f.state.runId, { type: 'run.finished', actor: { type: 'system', id: 'test' }, data: { status: 'failed' } })
  f.sync.mockRejectedValueOnce(new Error('模拟历史同步失败'))
  let loaded = true
  f.start(() => loaded ? [f.stores] : [])
  await vi.waitFor(() => expect(f.errors).toHaveBeenCalledTimes(1))
  await vi.advanceTimersByTimeAsync(1000)
  await f.synced()
  loaded = false
  await vi.advanceTimersByTimeAsync(1000)
  loaded = true
  await vi.advanceTimersByTimeAsync(1000)
  await vi.waitFor(() => expect(f.sync).toHaveBeenCalledTimes(3))
  expect(f.subscribe).not.toHaveBeenCalled()
})

it('空间卸载和 close 取消活动订阅', async () => {
  const f = await setup('running')
  let loaded = true
  const worker = f.start(() => loaded ? [f.stores] : [])
  await vi.waitFor(() => expect(f.subscribe).toHaveBeenCalledTimes(1))
  loaded = false
  await vi.advanceTimersByTimeAsync(1000)
  await vi.waitFor(() => expect(f.stop).toHaveBeenCalledTimes(1))
  loaded = true
  await vi.advanceTimersByTimeAsync(1000)
  await vi.waitFor(() => expect(f.subscribe).toHaveBeenCalledTimes(2))
  await worker.close()
  expect(f.stop).toHaveBeenCalledTimes(2)
  workers.splice(workers.indexOf(worker), 1)
})
