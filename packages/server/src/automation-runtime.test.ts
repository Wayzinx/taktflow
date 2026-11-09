import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { AutomationRecords, FsEventStore, initProject, openProject, type AutomationConfig, type RunState } from '@taktflow/core'
import { AutomationRuntime } from './automation-runtime.js'
const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => { vi.useRealTimers(); for (const fn of cleanup.splice(0).reverse()) await fn(); vi.unstubAllEnvs() })
const base: AutomationConfig = { id: 'notice', title: '通知', enabled: true, trigger: { schedule: '* * * * *' }, action: { kind: 'notify', text: 'hello {{run.status}}' }, notify: { channels: ['chat'] } }
async function fixture(automations: AutomationConfig[], fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response('ok'))) {
  const root = await mkdtemp(join(tmpdir(), 'takt-scheduler-')); cleanup.push(() => rm(root, { recursive: true, force: true }))
  vi.stubEnv('TAKT_SECRETS_FILE', join(root, 'keys.json')); vi.stubEnv('AUTOMATION_URL', 'https://fixture.invalid/hook')
  const stores = await initProject(root)
  const config = { ...stores.config, automations, channels: [{ id: 'chat', kind: 'slack', urlEnv: 'AUTOMATION_URL' }] }
  await writeFile(join(root, 'takt.config.json'), JSON.stringify(config))
  const runtime = new AutomationRuntime(root, { publicUrl: 'http://localhost:1234', fetch: fetcher })
  cleanup.push(() => runtime.close())
  return { root, stores, runtime, fetcher, records: new AutomationRecords(stores) }
}
it('每分钟对齐、同一分钟只触发一次、停机错过不补跑', async () => {
  const f = await fixture([base])
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] }); vi.setSystemTime(new Date(2026, 10, 9, 9, 0, 20))
  await f.runtime.start()
  const execute = vi.spyOn(f.runtime, 'execute').mockResolvedValue({ id: 'fake', automationId: 'notice', at: new Date().toISOString(), trigger: 'schedule', status: 'ok', summary: '', deliveries: [] })
  await vi.advanceTimersByTimeAsync(39_999); expect(execute).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(1)
  // tick 包含异步文件读取，显式等待它推进，而不让假时钟继续前进。
  await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(1))
  await f.runtime.tick(); expect(execute).toHaveBeenCalledTimes(1)
  await f.runtime.close(); vi.setSystemTime(new Date(2026, 10, 9, 12, 0, 20))
  const restarted = new AutomationRuntime(f.root, { publicUrl: 'http://localhost:1234', fetch: f.fetcher }); cleanup.push(() => restarted.close())
  await restarted.start()
  expect(f.fetcher).not.toHaveBeenCalled()
  await restarted.close()
})
it('上一轮未结束记 skipped，开始先落 running，终态覆盖同一执行记录', async () => {
  let release!: (response: Response) => void
  const fetcher = vi.fn<typeof fetch>().mockImplementation(() => new Promise(resolve => { release = resolve }))
  const f = await fixture([base], fetcher); await f.runtime.start()
  const first = f.runtime.execute('notice', 'manual')
  await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1))
  expect((await f.records.list())[0]!.status).toBe('running')
  const second = await f.runtime.execute('notice', 'schedule')
  expect(second).toMatchObject({ status: 'skipped', summary: '上一轮尚未结束，跳过本轮' })
  release(new Response('ok')); expect((await first).status).toBe('ok')
  expect(await f.records.list()).toHaveLength(2)
})
it('状态轮询 run.failed 按 workflow/需求过滤，自动启动运行只通知不启动', async () => {
  const f = await fixture([
    { ...base, trigger: { event: 'run.failed', filter: { workflowIds: ['w'], requirementIds: ['REQ-001'] } } },
    { ...base, id: 'start', trigger: { event: 'run.failed', filter: { requirementIds: ['REQ-001'] } }, action: { kind: 'start_workflow', workflowId: 'w' } },
  ])
  const req = await f.stores.workspaces.createRequirement({ title: '事件', id: 'REQ-001' })
  const run: RunState = { runId: 'run-event', workflowId: 'w', workflowVersion: '1', requirementId: req.id, args: { __taktAutomation: 'upstream' }, nodes: {}, expansions: [], status: 'running', startedAt: new Date().toISOString() }
  await f.stores.runs.create(run, { id: 'w', title: 'workflow', version: '1', stages: [], nodes: [] })
  await f.runtime.start()
  await f.runtime.dispatch({ type: 'run.failed', requirementId: 'OTHER' }); expect(f.fetcher).not.toHaveBeenCalled()
  await f.stores.runs.save({ ...run, status: 'failed', endedAt: new Date().toISOString() })
  await f.runtime.scan()
  await vi.waitFor(async () => expect((await f.records.list('notice'))[0]?.status).toBe('ok'))
  expect(f.fetcher).toHaveBeenCalledTimes(1); expect(await f.records.list('start')).toHaveLength(0)
  await f.runtime.scan(); expect(f.fetcher).toHaveBeenCalledTimes(1)
  expect((await f.records.list('notice'))[0]!.text).toBe('hello failed')
})
it('新需求触发；attention.overdue 同一待办跨重启也只触发一次', async () => {
  const f = await fixture([{ ...base, trigger: { event: 'attention.overdue' } }, { ...base, id: 'created', trigger: { event: 'requirement.created' } }])
  await f.runtime.start()
  const req = await f.stores.workspaces.createRequirement({ title: '新需求' })
  await f.runtime.scan()
  await vi.waitFor(async () => expect((await f.records.list('created'))[0]?.status).toBe('ok'))
  await f.stores.attention.create({ requestId: 'waiting', runId: 'no-run', nodeId: 'human', requirementId: req.id, form: 'answer', ask: '请处理', timebox: { remindAfter: '1m' } })
  await f.runtime.tick(new Date(Date.now() + 120_000))
  await f.runtime.tick(new Date(Date.now() + 180_000))
  await vi.waitFor(async () => expect((await f.records.list('notice'))[0]?.status).toBe('ok'))
  expect(await f.records.list('notice')).toHaveLength(1)
  await f.runtime.close()
  const restarted = new AutomationRuntime(f.root, { publicUrl: 'http://localhost:1234', fetch: f.fetcher }); cleanup.push(() => restarted.close())
  await restarted.start(); await restarted.tick(new Date(Date.now() + 240_000)); await restarted.close()
  expect(await f.records.list('notice')).toHaveLength(1)
  expect(await readFile(join(f.stores.taktDir, 'automations/overdue.json'), 'utf8')).toContain('waiting')
})

it('启动历史终态不补派，运行状态变化只派一次，全路径不读事件也不订阅', async () => {
  const f = await fixture([{ ...base, trigger: { event: 'run.finished' } }, { ...base, id: 'failure', trigger: { event: 'run.failed' } }])
  const read = vi.spyOn(FsEventStore.prototype, 'read'), subscribe = vi.spyOn(FsEventStore.prototype, 'subscribe')
  const workflow = { id: 'w', title: 'w', version: '1', stages: [], nodes: [] }
  const run: RunState = { runId: 'active', requirementId: 'REQ-001', workflowId: 'w', workflowVersion: '1', args: {}, nodes: {}, expansions: [], status: 'running', startedAt: new Date().toISOString() }
  try {
    await f.stores.runs.create({ ...run, runId: 'old', status: 'succeeded' }, workflow)
    await f.stores.runs.create(run, workflow)
    await f.runtime.start()
    const dispatch = vi.spyOn(f.runtime, 'dispatch')
    await f.runtime.scan()
    expect(dispatch).not.toHaveBeenCalled()
    await f.stores.runs.save({ ...run, status: 'succeeded' })
    await f.runtime.scan(); await f.runtime.scan()
    expect(dispatch).toHaveBeenCalledExactlyOnceWith({ type: 'run.finished', runId: 'active', requirementId: 'REQ-001' })
    await f.stores.runs.create({ ...run, runId: 'fast', startedAt: new Date().toISOString(), status: 'failed' }, workflow)
    await f.runtime.scan(); await f.runtime.scan()
    expect(dispatch).toHaveBeenCalledTimes(2)
    expect(dispatch).toHaveBeenLastCalledWith({ type: 'run.failed', runId: 'fast', requirementId: 'REQ-001' })
    await f.runtime.close()
    await f.runtime.scan()
    expect(read).not.toHaveBeenCalled()
    expect(subscribe).not.toHaveBeenCalled()
  } finally { read.mockRestore(); subscribe.mockRestore() }
})
it('5 秒扫描一次，通过空间 getter 读取热更新对象', async () => {
  const f = await fixture([])
  let current = await openProject(f.root)
  const runtime = new AutomationRuntime(f.root, { publicUrl: 'http://localhost:1234', getStores: () => current, fetch: f.fetcher })
  cleanup.push(() => runtime.close())
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] })
  await runtime.start()
  const scan = vi.spyOn(runtime, 'scan')
  await vi.advanceTimersByTimeAsync(4999); expect(scan).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(1); expect(scan).toHaveBeenCalledOnce()
  current = { ...current, config: { ...current.config, automations: [base] } }
  const result = await runtime.execute('notice', 'manual')
  expect(result.status).toBe('ok')
  await runtime.close()
  await vi.advanceTimersByTimeAsync(5000); expect(scan).toHaveBeenCalledOnce()
})
