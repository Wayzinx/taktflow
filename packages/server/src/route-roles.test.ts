import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { createServer, type RunningServer } from './index.js'
import { initSpace } from './space-admin.js'

const roots: string[] = [], servers: RunningServer[] = []
afterEach(async () => { for (const server of servers.splice(0)) await server.close(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'takt-route-roles-')); roots.push(root)
  const stores = await initSpace(root, 'quick', { name: '权限' })
  const members = (['owner', 'maintainer', 'member', 'viewer'] as const).map((role) => ({ id: role, name: role, role }))
  await writeFile(join(root, 'takt.config.json'), JSON.stringify({ ...stores.config, members }))
  const server = await createServer({ projectDir: root, port: 0 }); servers.push(server)
  const request = async (path: string, method: string, user: string, data?: unknown) => {
    const response = await fetch(`${server.url}/api${path}`, { method, headers: { 'content-type': 'application/json', 'x-takt-user': user }, body: data === undefined ? undefined : JSON.stringify(data) })
    return { status: response.status, data: await response.json() as any }
  }
  return { request }
}

it('匿名 web 即使是旧配置里的 owner 也不能写空间或流水线', async () => {
  const root = await mkdtemp(join(tmpdir(), 'takt-anonymous-role-')); roots.push(root)
  const stores = await initSpace(root, 'blank')
  await writeFile(join(root, 'takt.config.json'), JSON.stringify({ ...stores.config, members: [{ id: 'web', name: 'web', role: 'owner' }, { id: 'alice', name: 'alice', role: 'owner' }] }))
  const server = await createServer({ projectDir: root, port: 0 }); servers.push(server)
  for (const [path, method, input] of [['/space/members', 'PUT', { members: [], reason: '修改' }], ['/workflows', 'POST', { id: 'anonymous', reason: '新建' }]] as const) {
    const response = await fetch(`${server.url}/api${path}`, { method, headers: { 'content-type': 'application/json', 'x-takt-user': 'web' }, body: JSON.stringify(input) })
    expect(response.status).toBe(403)
  }
  expect((await (await fetch(`${server.url}/api/me`)).json()).id).toBe('alice')
})

it('只剩历史 web owner 的空间也不能通过无身份的命令请求绕过权限', async () => {
  const root = await mkdtemp(join(tmpdir(), 'takt-web-command-')); roots.push(root)
  const stores = await initSpace(root, 'blank')
  await writeFile(join(root, 'takt.config.json'), JSON.stringify({ ...stores.config, members: [{ id: 'web', name: 'web', role: 'owner' }] }))
  const server = await createServer({ projectDir: root, port: 0 }); servers.push(server)
  const response = await fetch(`${server.url}/api/commands/config.patch`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ input: { patch: { project: { name: '匿名改名' } } }, reason: '权限探测' }) })
  expect(response.status).toBe(403)
  expect((await response.json()).error).toContain('匿名身份 web')
})

it('member 不能改流水线：PATCH / PUT source / PUT layout / rollback 都要 maintainer，maintainer 可以', async () => {
  const { request } = await setup()
  const doc = (await request('/workflows/quick-fix', 'GET', 'viewer')).data
  const writes = [
    ['PATCH', '/workflows/quick-fix', { baseRev: doc.rev, edits: [{ op: 'setMeta', key: 'title', value: '改名' }], reason: '验收' }, '修改流水线'],
    ['PUT', '/workflows/quick-fix/source', { baseRev: doc.rev, source: doc.source, reason: '验收' }, '修改流水线源码'],
    ['PUT', '/workflows/quick-fix/layout', { nodes: { spec: { x: 1, y: 2 } } }, '调整流水线布局'],
    ['POST', '/workflows/quick-fix/rollback', { rev: doc.rev, reason: '验收' }, '回滚流水线'],
  ] as const
  for (const [method, path, input, what] of writes) for (const user of ['member', 'viewer']) {
    const denied = await request(path, method, user, input)
    expect(denied.status, `${user} ${method} ${path}`).toBe(403)
    expect(denied.data.error).toBe(`权限不足：${what}需要 maintainer 或更高角色，你（${user}）在本空间是 ${user}${user === 'viewer' ? '（只读）' : ''}`)
  }
  // 不存在的 workflow 也先校验权限，不再借 404 暴露"权限检查已通过"
  expect((await request('/workflows/nope', 'PATCH', 'member', { baseRev: doc.rev, edits: [] })).status).toBe(403)
  const edited = await request('/workflows/quick-fix', 'PATCH', 'maintainer', writes[0][2])
  expect(edited.status, JSON.stringify(edited.data)).toBe(200)
  expect(edited.data.model.meta.title).toMatchObject({ value: '改名' })
  expect((await request('/workflows/quick-fix/layout', 'PUT', 'maintainer', writes[2][2])).status).toBe(200)
  expect((await request('/workflows/quick-fix/rollback', 'POST', 'maintainer', writes[3][2])).status).toBe(200)
}, 60_000)

it('403 提示写出路由真正需要的角色：viewer 改成员看到"需要 owner"，不是兜底的"需要 member"', async () => {
  const { request } = await setup()
  const members = { members: [{ id: 'owner', name: 'owner', role: 'owner' }], reason: '验收' }
  for (const user of ['viewer', 'member', 'maintainer']) {
    const denied = await request('/space/members', 'PUT', user, members)
    expect(denied.status).toBe(403)
    expect(denied.data.error).toContain('修改空间成员需要 owner')
    expect(denied.data.error).toContain(`你（${user}）在本空间是 ${user}`)
  }
  expect((await request('/space/repos', 'POST', 'viewer', { id: 'app2', path: '.', defaultBranch: 'main', reason: '验收' })).data.error).toContain('绑定代码仓库需要 maintainer')
  for (const [method, path] of [['PATCH', '/space/runtime'], ['PUT', '/space/agents/dev'], ['PUT', '/space/automations/job'], ['POST', '/space/channels/test/test'], ['PUT', '/space/files?kind=agent&name=dev']] as const) {
    const denied = await request(path, method, 'viewer', {})
    expect(denied.status).toBe(403)
    expect(denied.data.error, path).toContain('需要 owner')
  }
  // 没有声明角色的写操作仍由兜底 member 校验，提示里也不出现路由路径
  const generic = await request('/requirements', 'POST', 'viewer', { title: '只读成员提需求', start: false })
  expect(generic.data.error).toBe('权限不足：修改需要 member 或更高角色，你（viewer）在本空间是 viewer（只读）')
  expect((await request('/requirements', 'POST', 'stranger', { title: '陌生人', start: false })).data.error).toContain('你（stranger）不是本空间的成员')
})
