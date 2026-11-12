import { mkdtemp, readFile, rm, writeFile, symlink } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it } from 'vitest'
import { openProject } from '@taktflow/core'
import { createServer, type RunningServer } from './index.js'
import { initSpace } from './space-admin.js'
import { projectCommands } from './space.js'
const roots: string[] = [], servers: RunningServer[] = []
afterEach(async () => { for (const server of servers.splice(0)) await server.close(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'takt-crud-http-')); roots.push(root)
  const server = await createServer({ spacesDir: root, port: 0 }); servers.push(server)
  const request = async (path: string, method = 'GET', data?: unknown) => {
    const response = await fetch(server.url + '/api' + path, { method, headers: { 'content-type': 'application/json', 'x-takt-user': 'alice' }, body: data === undefined ? undefined : JSON.stringify(data) })
    return { status: response.status, data: response.status === 204 ? undefined : await response.json() as any }
  }
  return { root, server, request }
}
it.each([undefined, ' \t\n', '  用户给定原因  '])('两个创建接口允许省略或空白 reason，审计保留默认或给定原因：%s', async (reason) => {
  const { root, request } = await setup()
  const extra = reason === undefined ? {} : { reason }
  expect((await request('/spaces', 'POST', { id: 'fresh', name: '新空间', template: 'blank', ...extra })).status).toBe(200)
  const adminAudit = (await readFile(join(root, '.takt/space-admin.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(JSON.parse(line).data.message))
  expect(adminAudit.at(-1).reason).toBe(reason?.trim() ? reason : '新建空间 fresh')
  for (const prefix of ['', '/s/fresh']) {
    const title = `验收需求 ${prefix || '默认空间'}`
    const created = await request(`${prefix}/requirements`, 'POST', { title, description: '背景与验收标准', start: false, ...extra })
    expect(created.status, JSON.stringify(created.data)).toBe(200)
    expect(created.data.requirement.title).toBe(title)
    const audit = (await readFile(join(root, 'fresh/.takt/space-events.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(JSON.parse(line).data.message))
    expect(audit.slice(-2).map((entry) => entry.reason)).toEqual(Array(2).fill(reason?.trim() ? reason : `新建需求 ${title}`))
  }
  const command = await request('/s/fresh/commands/requirement.create', 'POST', { input: { title: '命令入口', start: false }, ...extra })
  expect(command.data.ok).toBe(true)
  const audit = (await readFile(join(root, 'fresh/.takt/space-events.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(JSON.parse(line).data.message))
  expect(audit.slice(-2).map((entry) => entry.reason)).toEqual(Array(2).fill(reason?.trim() ? reason : '新建需求 命令入口'))
})

it('编辑、归档、恢复和删除接口仍拒绝缺失或空白 reason', async () => {
  const { request } = await setup()
  await request('/spaces', 'POST', { id: 'fresh', name: '新空间', template: 'blank' })
  const created = await request('/s/fresh/requirements', 'POST', { title: '验收需求', start: false })
  const req = `/s/fresh/requirements/${created.data.requirement.id}`
  const archived = 'fresh@20261107-010203'
  const writes = [
    ['PATCH', req, { title: '修改' }], ['POST', `${req}/archive`, {}], ['POST', `${req}/restore`, {}], ['DELETE', req, {}],
    ['PATCH', '/spaces/fresh', { name: '修改' }], ['POST', '/spaces/fresh/archive', {}], ['POST', `/spaces/${archived}/restore`, {}],
    ['DELETE', `/spaces/${archived}`, { confirm: archived }],
  ] as const
  for (const [method, path, input] of writes) for (const reason of [undefined, ' \t\n']) {
    const response = await request(path, method, { ...input, ...(reason === undefined ? {} : { reason }) })
    expect(response.status, `${method} ${path}: ${JSON.stringify(response.data)}`).toBe(400)
  }
})

it('空根目录在线创建空间，需求 CRUD、归档过滤、归档空间恢复后可读', async () => {
  const { root, request } = await setup()
  expect((await request('/server')).data.multiSpace).toBe(true)
  expect((await request('/spaces', 'POST', { id: 'fresh', name: '新空间', template: 'blank', reason: '验证' })).status).toBe(200)
  const created = await request('/s/fresh/requirements', 'POST', { title: '新需求', description: 'PRD', start: false, reason: '验证', attachments: [{ name: '内容.txt', content: '附件' }] })
  expect(created.status).toBe(200)
  const id = created.data.requirement.id
  expect(await readFile(join(root, 'fresh/requirements', id, 'inputs/prd.md'), 'utf8')).toBe('PRD')
  expect((await request(`/s/fresh/requirements/${id}`, 'PATCH', { dueAt: '2027-01-01', owner: 'alice', reason: '编辑' })).data.dueAt).toBe('2027-01-01')
  expect((await request(`/s/fresh/requirements/${id}`, 'PATCH', { dueAt: null, reason: '清除' })).data.dueAt).toBeUndefined()
  expect((await request(`/s/fresh/requirements/${id}/archive`, 'POST', { reason: '归档' })).status).toBe(200)
  expect((await request('/s/fresh/requirements')).data).toEqual([])
  expect((await request('/s/fresh/requirements?archived=1')).data).toHaveLength(1)
  expect((await request('/s/fresh/project')).data.requirements).toEqual([])
  await request(`/s/fresh/requirements/${id}/restore`, 'POST', { reason: '恢复' })
  const archived = await request('/spaces/fresh/archive', 'POST', { reason: '归档空间' })
  expect(archived.status).toBe(200)
  expect((await request('/s/fresh/requirements')).status).toBe(404)
  expect((await request(`/spaces/${archived.data.id}/restore`, 'POST', { reason: '恢复空间' })).status).toBe(200)
  expect((await request('/s/fresh/requirements')).data).toHaveLength(1)
  expect((await request(`/s/fresh/requirements/${id}`, 'DELETE', { reason: '删除' })).status).toBe(204)
  const stores = await openProject(join(root, 'fresh'))
  expect(await stores.workspaces.getRequirement(id)).toBeUndefined()
  expect(await stores.chat.getRoom(id)).toBeUndefined()
  expect(await stores.attention.list({ requirementId: id })).toEqual([])
})
it('已有运行拒绝删除，运行中拒绝归档需求和空间', async () => {
  const { root, request } = await setup()
  await request('/spaces', 'POST', { id: 'busy', name: '运行中', template: 'blank', reason: '验证' })
  const created = await request('/s/busy/requirements', 'POST', { title: '任务', workflowId: 'test', start: false, reason: '验证' })
  const stores = await openProject(join(root, 'busy')), id = created.data.requirement.id
  await stores.runs.create({ runId: 'busy-run', requirementId: id, workflowId: 'test', status: 'running', startedAt: new Date().toISOString(), nodes: {}, expansions: [], args: {} } as never, { id: 'test', title: 'test', version: '1', stages: [], nodes: [] })
  expect((await request(`/s/busy/requirements/${id}`, 'DELETE', { reason: '删除' })).status).toBe(409)
  expect((await request(`/s/busy/requirements/${id}/archive`, 'POST', { reason: '归档' })).status).toBe(409)
  expect((await request('/spaces/busy/archive', 'POST', { reason: '归档' })).status).toBe(409)
})
it('workflow 转换 dryRun 不写源码，保存后有修订和审计，命令权限生效', async () => {
  const { root, request } = await setup()
  const stores = await initSpace(join(root, 'flow'), 'blank')
  await writeFile(join(stores.projectDir, 'package.json'), '{"type":"module"}')
  await symlink(resolve('node_modules'), join(stores.projectDir, 'node_modules'), 'dir')
  const file = join(stores.paths.workflows, 'demo.workflow.ts'), source = "export default { id: 'demo', title: '示例', version: '1', stages: [], nodes: [] }"
  await writeFile(file, source)
  const commands = projectCommands(stores)
  expect((await commands.run('workflow.convert', { workflowId: 'demo' }, { actor: { type: 'agent', role: 'lead', harness: 'mock' }, reason: '转换' })).ok).toBe(false)
  // 第二个服务读取现有空间，转换路由与命令共用存储。
  const second = await createServer({ projectDir: stores.projectDir, port: 0 }); servers.push(second)
  const post = async (value: unknown) => { const response = await fetch(second.url + '/api/workflows/demo/convert', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) }); return response.json() as Promise<any> }
  const preview = await post({ dryRun: true })
  expect(preview.ok, JSON.stringify(preview)).toBe(true); expect(preview.diff).toContain('defineWorkflow')
  expect(await readFile(file, 'utf8')).toBe(source)
  const saved = await post({ reason: '转换' })
  expect(saved.document.model.editable).toBe(true)
  expect(await readFile(file, 'utf8')).toContain('defineWorkflow')
  expect(await readFile(join(stores.taktDir, 'space-events.jsonl'), 'utf8')).toContain('workflow.convert')
  expect((await post({ dryRun: true })).reason).toBe('已是可编辑写法')
}, 15000)

it('没选「我是谁」（不带 x-takt-user）时，全局空间操作按目标空间的 owner 认人，不再被当成非成员拒掉', async () => {
  const { root, server, request } = await setup()
  expect((await request('/spaces', 'POST', { id: 'mine', name: '我的空间', template: 'blank' })).status).toBe(200)
  const anonymous = async (path: string, method: string, data: unknown) => {
    const response = await fetch(server.url + '/api' + path, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) })
    return { status: response.status, data: await response.json() as any }
  }
  expect((await anonymous('/spaces/mine', 'PATCH', { name: '改名', reason: '改名' })).status).toBe(200)
  const archived = await anonymous('/spaces/mine/archive', 'POST', { reason: '归档' })
  expect(archived.status, JSON.stringify(archived.data)).toBe(200)
  expect((await anonymous(`/spaces/${archived.data.id}/restore`, 'POST', { reason: '恢复' })).status).toBe(200)
  const audit = (await readFile(join(root, '.takt/space-admin.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line).actor.id)
  expect(audit.slice(-3)).toEqual(['alice', 'alice', 'alice'])
  // 带了别的身份仍按那个人判权限
  const response = await fetch(server.url + '/api/spaces/mine/archive', { method: 'POST', headers: { 'content-type': 'application/json', 'x-takt-user': 'mallory' }, body: JSON.stringify({ reason: '归档' }) })
  expect(response.status).toBe(403)
})

it('空根目录没有可推断的创建者时拒绝创建，不能生成匿名开放空间', async () => {
  const { server } = await setup()
  const response = await fetch(`${server.url}/api/spaces`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 'anonymous', name: '匿名空间', template: 'blank' }) })
  expect(response.status).toBe(403)
  expect((await response.json()).error).toContain('创建者身份')
})

it('没选"我是"时全局空间接口按被操作的空间推断操作者：能复制自己是 owner 的空间，新空间不多出 web', async () => {
  const root = await mkdtemp(join(tmpdir(), 'takt-crud-actor-')); roots.push(root)
  for (const [id, members] of [['source', [{ id: 'demo-owner', name: '示例负责人', role: 'owner' }, { id: 'reader', name: 'reader', role: 'viewer' }]], ['team', [{ id: 'demo-owner', name: '示例负责人', role: 'owner' }, { id: 'wazinx', name: 'wazinx', role: 'maintainer' }]]] as const) {
    const stores = await initSpace(join(root, id), 'quick', { name: id === 'source' ? '来源' : '团队' })
    await writeFile(join(stores.projectDir, 'takt.config.json'), JSON.stringify({ ...stores.config, space: { id }, members }))
  }
  const server = await createServer({ spacesDir: root, port: 0 }); servers.push(server)
  const request = async (path: string, method: string, data: unknown, user?: string) => {
    const response = await fetch(`${server.url}/api${path}`, { method, headers: { 'content-type': 'application/json', ...(user ? { 'x-takt-user': user } : {}) }, body: JSON.stringify(data) })
    return { status: response.status, data: await response.json() as any }
  }
  const membersOf = async (id: string) => (await openProject(join(root, id))).config.members
  const creator = [{ id: 'demo-owner', name: '示例负责人', role: 'owner' }]
  expect((await request('/spaces', 'POST', { id: 'web-created', name: '匿名空间', template: 'blank' }, 'web')).status).toBe(403)
  expect((await request('/spaces', 'POST', { id: 'web-member', name: '匿名成员', template: 'blank', members: [{ id: 'web', name: 'web', role: 'owner' }] }, undefined)).status).toBe(400)
  // 向导：未选身份，第 3 步显示的创建者放在 members 里
  for (const from of ['source', 'team']) {
    const copied = await request('/spaces', 'POST', { id: `copy-${from}`, name: `复制-${from}`, template: { copyFrom: from, parts: ['agents', 'workflows'] }, members: creator }, undefined)
    expect(copied.status, JSON.stringify(copied.data)).toBe(200)
    expect(await membersOf(`copy-${from}`)).toEqual(creator)
  }
  expect((await request('/spaces', 'POST', { id: 'blank-one', name: '空白', template: 'blank', members: creator }, undefined)).status).toBe(200)
  expect(await membersOf('blank-one')).toEqual(creator)
  // 不给成员：缺省空间的第一个 owner 是创建者
  expect((await request('/spaces', 'POST', { id: 'blank-two', name: '空白二', template: 'blank' }, undefined)).status).toBe(200)
  expect(await membersOf('blank-two')).toEqual([{ id: 'demo-owner', name: 'demo-owner', role: 'owner' }])
  const audit = (await readFile(join(root, '.takt/space-admin.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line).actor)
  expect(audit.every((by: { id: string }) => by.id === 'demo-owner')).toBe(true)
  // 明确选了身份就按那个人校验，提示说清是哪个空间、需要什么角色，不露内部命令名
  const denied = await request('/spaces', 'POST', { id: 'copy-denied', name: '无权复制', template: { copyFrom: 'source', parts: ['agents'] } }, 'reader')
  expect(denied.status).toBe(403)
  expect(denied.data.error).toBe('权限不足：复制这个空间需要 maintainer 或更高角色，你（reader）在「来源」是 viewer（只读）')
  expect((await request('/spaces', 'POST', { id: 'copy-stranger', name: '陌生人', template: { copyFrom: 'team', parts: ['agents'] } }, 'reader')).data.error).toContain('不是「团队」的成员')
  // 归档 / 恢复同样按被操作的空间推断（新空间不再靠幽灵 web owner 才能撤销）
  const archived = await request('/spaces/blank-one/archive', 'POST', { reason: '撤销新建空间' }, undefined)
  expect(archived.status, JSON.stringify(archived.data)).toBe(200)
  expect((await request(`/spaces/${archived.data.id}/restore`, 'POST', { reason: '恢复' }, undefined)).status).toBe(200)
  expect((await request('/spaces/blank-one', 'PATCH', { name: '改名', reason: '验收' }, 'reader')).status).toBe(403)
})
