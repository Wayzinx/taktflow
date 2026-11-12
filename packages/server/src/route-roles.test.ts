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
  // 没有声明角色的写操作仍由兜底 member 校验，提示里也不出现路由路径
  const generic = await request('/requirements', 'POST', 'viewer', { title: '只读成员提需求', start: false })
  expect(generic.data.error).toBe('权限不足：修改需要 member 或更高角色，你（viewer）在本空间是 viewer（只读）')
  expect((await request('/requirements', 'POST', 'stranger', { title: '陌生人', start: false })).data.error).toContain('你（stranger）不是本空间的成员')
})
