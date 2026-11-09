import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { initProject, AutomationRecords, openProject, type AutomationConfig, type AutomationRunRecord, type TaktConfig } from '@taktflow/core'
import { createServer, type ServerOptions } from './index.js'
import { projectCommands } from './space.js'
const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); vi.unstubAllEnvs() })
async function fixture(extra: Partial<ServerOptions> = {}, multi = false) {
  const root = await mkdtemp(join(tmpdir(), 'takt-automation-http-')); cleanup.push(() => rm(root, { recursive: true, force: true }))
  vi.stubEnv('TAKT_SECRETS_FILE', join(root, 'keys.json')); vi.stubEnv('AUTOMATION_URL', 'https://fixture.invalid/hook'); vi.stubEnv('TAKT_PUBLIC_URL', 'https://app.invalid')
  const stores = await initProject(join(root, 'space'))
  const config: TaktConfig = { ...stores.config, members: [{ id: 'owner', name: 'O', role: 'owner' }, { id: 'member', name: 'M', role: 'member' }], channels: [{ id: 'chat', kind: 'slack', urlEnv: 'AUTOMATION_URL' }] }
  await writeFile(join(stores.projectDir, 'takt.config.json'), JSON.stringify(config))
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response('ok'))
  const server = await createServer({ ...(multi ? { spacesDir: root } : { projectDir: stores.projectDir }), port: 0, automationFetch: fetcher, ...extra })
  cleanup.push(() => server.close())
  const prefix = multi ? '/api/s/space' : '/api'
  const request = (path: string, method = 'GET', input?: object, user = 'owner') => fetch(server.url + prefix + path, { method, headers: { 'content-type': 'application/json', 'x-takt-user': user }, ...(input ? { body: JSON.stringify(input) } : {}) })
  const save = (a: AutomationConfig) => request(`/space/automations/${a.id}`, 'PUT', { automation: a, reason: '配置自动化' })
  const trigger = async (id: string) => (await request(`/space/automations/${id}/trigger`, 'POST', { reason: '手动执行' })).json() as Promise<AutomationRunRecord>
  return { stores, root, request, save, trigger, fetcher, close: server.close }
}
const notify: AutomationConfig = { id: 'notice', title: '告警', enabled: true, trigger: { event: 'run.failed' }, action: { kind: 'notify', text: '{{requirement.title}}|{{run.id}}|{{run.status}}|{{node.id}}|{{link}}' }, notify: { channels: ['chat'] } }
it('配置写回、热加载、手动占位符为空、渠道测试、owner 与引用删除保护', async () => {
  const f = await fixture({}, true)
  expect((await f.save(notify)).status).toBe(200)
  const view = await (await f.request('/space/automations')).json()
  expect(view.automations[0].problems).toEqual([]); expect(view.channels[0]).toMatchObject({ url: 'env', usedBy: ['notice'] })
  expect(JSON.stringify(view)).not.toContain('fixture.invalid')
  const row = await f.trigger('notice'); expect(row).toMatchObject({ status: 'ok', trigger: 'manual', text: '||||' })
  expect((await (await f.request('/space/automations/notice/runs')).json())[0].id).toBe(row.id)
  expect((await f.request('/space/automations/notice/runs/' + row.id + '/retry', 'POST', { reason: '错误重试' })).status).toBe(409)
  expect((await f.request('/space/channels/chat', 'DELETE', { reason: '删除' })).status).toBe(409)
  expect((await f.request('/space/automations/notice/trigger', 'POST', { reason: '越权' }, 'member')).status).toBe(403)
  expect((await f.request('/space/automations/notice/trigger', 'POST', {})).status).toBe(400)
  expect((await f.request('/space/channels/chat/test', 'POST', { reason: '测试' })).status).toBe(200)
  expect(JSON.parse(f.fetcher.mock.calls.at(-1)![1]!.body as string).text).toBe('takt 渠道测试：space')
  expect(await new AutomationRecords(await openProject(f.stores.projectDir)).list()).toHaveLength(1)
  expect((await f.request('/space/automations/notice', 'DELETE', { reason: '删除' })).status).toBe(204)
  expect((await (await f.request('/space/automations')).json()).automations).toEqual([])
  expect(await new AutomationRecords(f.stores).list('notice')).toHaveLength(1)
  expect((await f.request('/space/channels/chat', 'DELETE', { reason: '删除' })).status).toBe(204)
  expect(await readFile(join(f.stores.taktDir, 'space-events.jsonl'), 'utf8')).toContain('配置自动化')
})
it('cron、定时需求、渠道引用、workflow 引用与密钥名校验', async () => {
  const f = await fixture()
  const cases = [
    { ...notify, trigger: { schedule: '0 25 * * *' } },
    { ...notify, notify: { channels: [] } },
    { ...notify, notify: { channels: ['missing'] } },
    { ...notify, trigger: { schedule: '* * * * *' }, action: { kind: 'start_workflow', workflowId: 'missing' } },
    { ...notify, action: { kind: 'start_workflow', workflowId: 'missing' } },
  ]
  for (const a of cases) expect((await f.save(a as AutomationConfig)).status).toBe(400)
  expect((await f.request('/space/channels/chat', 'PUT', { reason: '配置', channel: { id: 'chat', kind: 'slack', urlEnv: 'https://secret.invalid' } })).status).toBe(400)
  const scheduled = { ...notify, trigger: { schedule: '*/15 * * * *' } }
  const result = await f.save(scheduled); expect(result.status).toBe(200); expect((await result.json()).nextAt).toBeTruthy()
  vi.stubEnv('AUTOMATION_URL', '')
  expect((await (await f.request('/space/automations')).json()).automations[0].problems.join('')).toContain('地址缺失')
  expect((await f.trigger('notice')).status).toBe('skipped')
})
it('失败记录沿用原事件重试，恢复 running，digest 去重及无变化跳过', async () => {
  const f = await fixture()
  const req = await f.stores.workspaces.createRequirement({ title: '需求标题' })
  await f.save(notify)
  const records = new AutomationRecords(f.stores)
  const original: AutomationRunRecord = { id: 'failed-id', automationId: 'notice', at: new Date().toISOString(), trigger: 'event', event: { type: 'requirement.created', requirementId: req.id }, status: 'failed', summary: '失败', deliveries: [] }
  await records.write(original)
  const response = await f.request('/space/automations/notice/runs/failed-id/retry', 'POST', { reason: '重试' })
  expect(response.status).toBe(200); expect(await response.json()).toMatchObject({ status: 'ok', trigger: 'retry', retryOf: 'failed-id', text: `需求标题||||https://app.invalid/req/${req.id}`, event: original.event })
  await f.save({ ...notify, id: 'digest', action: { kind: 'digest' } })
  expect(await f.trigger('digest')).toMatchObject({ status: 'ok', summary: '已推送 1 个需求的进展', text: expect.stringContaining('需求标题｜新建需求') })
  expect(await f.trigger('digest')).toMatchObject({ status: 'skipped', summary: expect.stringContaining('没有任何变化') })
  await f.close()
  await records.write({ ...original, id: 'interrupted', status: 'running' })
  const reopened = await createServer({ projectDir: f.stores.projectDir, port: 0, automationFetch: f.fetcher }); cleanup.push(() => reopened.close())
  expect((await records.list('notice')).find(r => r.id === 'interrupted')).toMatchObject({ status: 'failed', error: 'serve 重启，执行中断' })
})
it('start_workflow 用现有命令与 automation Actor，已有运行与缺失需求跳过', async () => {
  const start = vi.fn(async () => ({ refs: { runId: 'run-created' } }))
  const f = await fixture({ getCommands: stores => projectCommands(stores, { startRun: start }) })
  const req = await f.stores.workspaces.createRequirement({ title: '自动启动' })
  await writeFile(join(f.stores.paths.workflows, 'work.workflow.ts'), `import { defineWorkflow } from '@taktflow/core'\nexport default defineWorkflow({ id: 'work', title: '工作', version: '1', stages: [], nodes: [] })`)
  const automation: AutomationConfig = { id: 'start', title: '自动启动', enabled: true, trigger: { schedule: '* * * * *' }, action: { kind: 'start_workflow', workflowId: 'work', requirementId: req.id } }
  expect((await f.save(automation)).status).toBe(200)
  expect(await f.trigger('start')).toMatchObject({ status: 'ok', runId: 'run-created' })
  expect(start.mock.calls[0]).toEqual([{ requirementId: req.id, workflowId: 'work', args: { __taktAutomation: 'start' } }, { actor: { type: 'agent', role: 'automation:start', harness: 'automation' }, reason: '自动化：自动启动' }])
  await f.stores.runs.create({ runId: 'running', requirementId: req.id, workflowId: 'work', workflowVersion: '1', status: 'running', args: {}, nodes: {}, expansions: [], startedAt: new Date().toISOString() }, { id: 'work', title: '工作', version: '1', stages: [], nodes: [] })
  expect(await f.trigger('start')).toMatchObject({ status: 'skipped', summary: expect.stringContaining('已有运行') })
  await f.save({ ...automation, action: { kind: 'start_workflow', workflowId: 'work', requirementId: 'missing' } })
  expect(await f.trigger('start')).toMatchObject({ status: 'skipped', summary: expect.stringContaining('不存在') })
  expect(start).toHaveBeenCalledTimes(1)
})
