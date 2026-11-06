import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { initProject, openProject } from '@taktflow/core'
import { attachLessons } from '@taktflow/server'
import { main } from './index.js'

const roots: string[] = []
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))) })
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'takt-cli-m3-')); roots.push(root)
  const stores = await initProject(root)
  stores.config.members = [{ id: 'alice', name: 'Alice', role: 'owner' }]
  stores.config.workflows = []
  await writeFile(join(root, 'takt.config.json'), JSON.stringify(stores.config))
  await writeFile(join(root, 'package.json'), '{"type":"module"}')
  await writeFile(join(stores.paths.workflows, 'quick.workflow.ts'), `export default { id: 'quick', title: '轻量流程', version: '1', tiers: ['T0','T1'], stages: [], nodes: [{ id: 'confirm', kind: 'human', title: '确认', ask: '确认', form: 'approve' }] }`)
  const req = await stores.workspaces.createRequirement({ title: 'src 调整', owner: 'alice' })
  return { root, stores, req }
}
async function cli(root: string, args: string[]) {
  const chunks: string[] = []
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => { chunks.push(String(chunk)); return true })
  try { const code = await main([...args, '--project', root, '--json']); return { code, data: JSON.parse(chunks.join('')) } }
  finally { spy.mockRestore() }
}

it('route、auto run、cmd answer 共用路由与预算，继续后回读已完成运行', async () => {
  const { root, stores, req } = await setup()
  const preview = await cli(root, ['route', req.id, '--tier', 'T0', '--reason', '给定 diff'])
  expect(preview.code).toBe(0); expect(preview.data.result).toMatchObject({ tier: 'T0', workflowId: 'quick' })
  expect((await cli(root, ['cmd', 'ls'])).data.some((item: { id: string }) => item.id === 'task.dispatch')).toBe(true)
  const started = await cli(root, ['run', 'auto', '--req', req.id, '--budget-tokens', '1200', '--budget-minutes', '5'])
  expect(started.code).toBe(0)
  expect(started.data).toMatchObject({ status: 'waiting_human', budget: { tokens: 1200, minutes: 5 }, route: { tier: 'T1', workflowId: 'quick' } })
  const pending = (await stores.attention.list({ pending: true }))[0]!
  const answer = await cli(root, ['cmd', 'attention.answer', '--input', JSON.stringify({ requestId: pending.requestId, decision: 'approve' }), '--reason', '人工确认'])
  expect(answer).toMatchObject({ code: 0, data: { ok: true } })
  expect((await (await openProject(root)).runs.get(started.data.runId))!.status).toBe('succeeded')
  expect((await stores.attention.list())[0]!.answeredBy).toEqual({ type: 'human', id: 'alice' })
})

it('cmd run.start 支持 auto 并写路由卡；经验 CLI 修改必须给原因', async () => {
  const { root, stores, req } = await setup()
  const started = await cli(root, ['cmd', 'run.start', '--input', JSON.stringify({ requirementId: req.id, workflowId: 'auto' }), '--reason', '启动需求'])
  expect(started.code).toBe(0)
  expect((await stores.chat.list(req.id)).some((message) => message.kind === 'route')).toBe(true)
  attachLessons(stores)
  await stores.lessons!.upsert({ id: 'lesson', title: '契约', body: '记录验证结果', status: 'tentative', trigger: {}, source: {}, stats: { recalled: 0, helped: 0, hurt: 0 } }, { type: 'human', id: 'alice' }, '录入')
  expect((await cli(root, ['lessons', 'activate', 'lesson'])).code).toBe(1)
  expect((await cli(root, ['lessons', 'activate', 'lesson', '--reason', '试用有效'])).code).toBe(0)
  expect((await cli(root, ['lessons', 'show', 'lesson'])).data.status).toBe('active')
  expect((await cli(root, ['lessons', 'retire', 'lesson', '--reason', '不再适用'])).code).toBe(0)
  expect((await cli(root, ['lessons', 'ls'])).data.result[0].status).toBe('retired')
})

it('m3-fix 27/34：运行时启动后编辑档位与新增 workflow，预览和 auto 启动立即使用新源码', async () => {
  const { root, stores, req } = await setup()
  const { loadRuntime } = await import('./project.js')
  const { createProjectLead } = await import('./lead.js')
  const lead = await createProjectLead(await loadRuntime(root))
  const actor = { type: 'human', id: 'alice' } as const
  expect((await lead.commands.run('route.preview', { requirementId: req.id }, { actor })).result).toMatchObject({ workflowId: 'quick' })
  const file = join(stores.paths.workflows, 'quick.workflow.ts')
  await writeFile(file, `export default { id: 'quick', title: '改为多面', version: '1', tiers: ['T2'], stages: [], nodes: [] }`)
  await writeFile(join(stores.paths.workflows, 'new.workflow.ts'), `export default { id: 'new', title: '新的单面流程', version: '1', tiers: ['T1'], stages: [], nodes: [{ id: 'confirm', kind: 'human', title: '新确认', ask: '确认', form: 'approve' }] }`)
  expect((await lead.commands.run('route.preview', { requirementId: req.id }, { actor })).result).toMatchObject({ workflowId: 'new', tier: 'T1' })
  expect((await lead.commands.run('run.start', { requirementId: req.id, workflowId: 'auto' }, { actor, reason: '热更新启动' })).ok).toBe(true)
  await lead.drain()
  const state = (await stores.runs.list()).find((run) => run.workflowId === 'new')!
  expect(state).toMatchObject({ route: { workflowId: 'new', tier: 'T1' }, args: { tier: 'T1', workflowRev: expect.stringMatching(/^[a-f0-9]{64}$/) } })
  expect((await stores.chat.list(req.id)).filter((message) => message.kind === 'route')).toHaveLength(1)
})
