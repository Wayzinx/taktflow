import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { createServer as createTcpServer, type AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { createEngine, initProject, openProject } from '@taktflow/core'
import { createServer, workflowStore, type RunningServer } from '@taktflow/server'
import { main } from './index.js'
import { createProjectLead } from './lead.js'
import { loadRuntime } from './project.js'

const roots: string[] = []
const servers: RunningServer[] = []
const children: ChildProcess[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(servers.splice(0).map((server) => server.close()))
  await Promise.all(children.splice(0).map(async (child) => { if (child.exitCode === null) { const done = new Promise<void>((resolve) => child.once('exit', () => resolve())); child.kill('SIGTERM'); await done } }))
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
async function temp() { const root = await mkdtemp(join(tmpdir(), 'takt-cli-lead-')); roots.push(root); return root }
async function fixture(steps: unknown[], root?: string) {
  const stores = await initProject(root ?? await temp())
  stores.config.workflows = []
  stores.config.lead = { harness: { harness: 'mock' }, progressUpdates: true }
  stores.config.members = [{ id: 'alice', name: 'Alice', role: 'owner' }]
  await writeFile(join(stores.projectDir, 'takt.config.json'), JSON.stringify(stores.config))
  await writeFile(join(stores.projectDir, 'package.json'), '{"type":"module"}')
  await symlink(resolve('node_modules'), join(stores.projectDir, 'node_modules'), 'dir')
  for (const role of ['lead', 'pm', 'reviewer']) await writeFile(join(stores.paths.agents, `${role}.md`), `---\nrole: ${role}\nharness: mock\nwriteScope: ["requirements/**/spec/**"]\n---\n角色 ${role}`)
  await writeFile(join(stores.taktDir, 'mock.json'), JSON.stringify({ steps }))
  const req = await stores.workspaces.createRequirement({ title: '群聊需求', owner: 'alice' })
  return { stores, req }
}
async function cli(root: string, args: string[]) {
  const output: string[] = []
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => { output.push(String(chunk)); return true })
  try { const code = await main([...args, '--project', root, '--json']); return { code, data: JSON.parse(output.join('')) } }
  finally { spy.mockRestore() }
}

it('chat post 在进程内触发 Lead，等待临时任务落盘，普通消息不触发', async () => {
  const { stores, req } = await fixture([
    { match: { role: 'lead' }, structured: { reply: '派发任务', actions: [{ type: 'dispatch_task', task: { role: 'pm', title: '写 PRD', instructions: '写 spec', outputs: [{ path: 'spec/prd.md', kind: 'spec' }], review: false } }] } },
    { match: { role: 'pm' }, writes: { '{{workspace}}/spec/prd.md': 'AC-2 新描述' }, finalText: '完成' },
  ])
  expect((await cli(stores.projectDir, ['chat', 'post', req.id, '普通消息'])).code).toBe(0)
  expect(await stores.runs.list()).toHaveLength(0)
  const result = await cli(stores.projectDir, ['chat', 'post', req.id, '@lead 写 PRD'])
  expect(result.code).toBe(0)
  const runs = await (await openProject(stores.projectDir)).runs.list()
  expect(runs.map((run) => run.workflowId).sort()).toEqual(['lead', 'task:pm'])
  expect(runs.every((run) => run.status === 'succeeded')).toBe(true)
  expect((runs.find((run) => run.workflowId === 'task:pm') as unknown as { origin: { messageId: string } }).origin.messageId).toBe(result.data.id)
  expect((await stores.workspaces.readArtifact({ workspace: req.id, path: 'spec/prd.md' }))?.toString()).toBe('AC-2 新描述')
})

it('HTTP 群聊提案经人工审批通过 workflow-source 应用，并保留作者、审批人和哈希链', async () => {
  const source = `import { defineWorkflow, script } from '@taktflow/core'\nexport default defineWorkflow({ id: 'sample', title: '旧标题', version: '1', stages: [], nodes: [script({ id: 'work', title: '工作', run: async () => {} })] })\n`
  const { stores, req } = await fixture([{ match: { role: 'lead' }, structured: { reply: '提出修改', actions: [{ type: 'propose_workflow_change', workflowId: 'sample', description: '改标题', source: source.replace('旧标题', '新标题') }] } }])
  await writeFile(join(stores.paths.workflows, 'sample.workflow.ts'), source)
  const lead = await createProjectLead(await loadRuntime(stores.projectDir))
  const server = await createServer({ projectDir: stores.projectDir, port: 0, onLeadMention: async (id, message) => { await lead.onMessage(id, message) }, onAnswer: async (item) => { await lead.onAttention(item) } }); servers.push(server)
  const posted = await fetch(`${server.url}/api/requirements/${req.id}/chat`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-takt-user': 'alice' }, body: JSON.stringify({ text: '@lead 改 workflow' }) })
  expect(posted.status).toBe(200)
  await vi.waitFor(async () => expect(await stores.attention.list({ pending: true })).toHaveLength(1), { timeout: 5000 })
  expect(await readFile(join(stores.paths.workflows, 'sample.workflow.ts'), 'utf8')).toBe(source)
  const pending = (await stores.attention.list({ pending: true }))[0]!
  const approved = await fetch(`${server.url}/api/attention/${encodeURIComponent(pending.requestId)}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-takt-user': 'alice' }, body: JSON.stringify({ decision: 'approve' }) })
  expect(approved.status).toBe(200)
  expect(await readFile(join(stores.paths.workflows, 'sample.workflow.ts'), 'utf8')).toContain('新标题')
  const revision = (await workflowStore(stores).revisions('sample')).at(-1)!
  expect(revision.author).toMatchObject({ type: 'agent', role: 'lead' })
  expect(revision.reason).toContain('alice')
  expect((await stores.events.read(pending.runId)).some((event) => event.type === 'log' && JSON.stringify(event.data).includes('onBehalfOf'))).toBe(true)
  expect(await stores.events.verify(pending.runId)).toEqual({ ok: true })
}, 15000)

it('serve --spaces 的默认 onLeadMention 为每个空间启动独立 Lead，运行与消息可从 HTTP 回读', async () => {
  const parent = await temp()
  const first = await fixture([{ match: { role: 'lead' }, structured: { reply: '空间一回复', actions: [] } }], join(parent, 'one'))
  const second = await fixture([{ match: { role: 'lead' }, structured: { reply: '空间二回复', actions: [] } }], join(parent, 'two'))
  const reservation = createTcpServer()
  await new Promise<void>((resolve) => reservation.listen(0, '127.0.0.1', resolve))
  const port = (reservation.address() as AddressInfo).port
  await new Promise<void>((resolve) => reservation.close(() => resolve()))
  const child = spawn(process.execPath, ['--import', 'tsx', resolve('packages/cli/src/index.ts'), 'serve', '--spaces', parent, '--port', String(port), '--json'], { stdio: ['ignore', 'pipe', 'pipe'] }); children.push(child)
  let output = ''; let errors = ''
  child.stdout!.on('data', (chunk) => { output += String(chunk) })
  child.stderr!.on('data', (chunk) => { errors += String(chunk) })
  let url = ''
  await vi.waitFor(() => { expect(child.exitCode, errors).toBeNull(); try { url = (JSON.parse(output) as { url: string }).url } catch {} expect(url).toMatch(/^http:/) }, { timeout: 12000 })
  expect(await (await fetch(url + '/api/spaces')).json()).toHaveLength(2)
  for (const [id, expected] of [['one', '空间一回复'], ['two', '空间二回复']]) {
    const response = await fetch(`${url}/api/s/${id}/requirements/REQ-001/chat`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: '@lead 现在进展如何' }) })
    expect(response.status).toBe(200)
    await vi.waitFor(async () => {
      const messages = await (await fetch(`${url}/api/s/${id}/requirements/REQ-001/chat`)).json() as Array<{ text: string }>
      expect(messages.some((message) => message.text === expected)).toBe(true)
    }, { timeout: 5000 })
    const runs = await (await fetch(`${url}/api/s/${id}/runs`)).json() as Array<{ workflowId: string; kind: string; origin: { messageId: string } }>
    expect(runs).toHaveLength(1); expect(runs[0]).toMatchObject({ workflowId: 'lead', kind: 'task', origin: { messageId: expect.any(String) } })
  }
  expect((await first.stores.chat.list(first.req.id)).some((message) => message.text === '空间二回复')).toBe(false)
  expect((await second.stores.chat.list(second.req.id)).some((message) => message.text === '空间一回复')).toBe(false)
}, 20000)


it('CLI answer 接上 Lead 提案审批；主流水线阶段不会被群聊回合与临时任务覆盖', async () => {
  const source = `import { defineWorkflow, script } from '@taktflow/core'\nexport default defineWorkflow({ id: 'sample', title: '旧标题', version: '1', stages: [], nodes: [script({ id: 'work', title: '工作', run: async () => {} })] })\n`
  const { stores, req } = await fixture([{ match: { role: 'lead' }, structured: { reply: '提出修改', actions: [
    { type: 'propose_workflow_change', workflowId: 'sample', description: '改标题', source: source.replace('旧标题', '新标题') },
    { type: 'dispatch_task', task: { role: 'pm', title: '产品备注', instructions: '写备注', review: false, outputs: [{ path: 'spec/note.md', kind: 'spec' }] } },
  ] } }, { match: { role: 'pm' }, writes: { '{{workspace}}/spec/note.md': '说明' }, finalText: '完成' }])
  await writeFile(join(stores.paths.workflows, 'sample.workflow.ts'), source)
  const pipeline = await createEngine({ stores, profiles: {}, harnesses: {}, knowledge: [] }).start({ requirementId: req.id, workflow: { id: 'delivery', title: '主流水线', version: '1', stages: [{ id: 'done', title: '交付' }], nodes: [{ id: 'done', title: '交付', kind: 'script', stage: 'done', run: async () => {} }] } })
  expect((await stores.workspaces.getRequirement(req.id))!.status).toBe('delivered')
  expect((await cli(stores.projectDir, ['chat', 'post', req.id, '@lead 改工作流并补产品备注'])).code).toBe(0)
  const pending = (await stores.attention.list({ pending: true }))[0]!
  expect((await cli(stores.projectDir, ['answer', pending.requestId, '--approve'])).code).toBe(0)
  expect(await readFile(join(stores.paths.workflows, 'sample.workflow.ts'), 'utf8')).toContain('新标题')
  expect((await stores.workspaces.getRequirement(req.id))!.status).toBe('delivered')
  const server = await createServer({ projectDir: stores.projectDir, port: 0 }); servers.push(server)
  const summary = await (await fetch(`${server.url}/api/requirements/${req.id}`)).json() as { status: string; latestRunId: string; stages: Array<{ id: string }> }
  expect(summary).toMatchObject({ status: 'delivered', latestRunId: pipeline.runId })
  expect(summary.stages.map((stage) => stage.id)).toEqual(['done'])
}, 15000)
