import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { createServer, type RunningServer } from './index.js'
import { initSpace } from './space-admin.js'

const roots: string[] = [], servers: RunningServer[] = []
afterEach(async () => { for (const server of servers.splice(0)) await server.close(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
const literal = (value: unknown) => ({ kind: 'literal' as const, value })

it('空空间不经管家新建流水线：空白可在画布上加节点，从模板复制补齐角色和辅助文件；要 maintainer', async () => {
  const root = await mkdtemp(join(tmpdir(), 'takt-workflow-create-')); roots.push(root)
  const stores = await initSpace(root, 'blank', { name: '空空间' })
  await writeFile(join(root, 'takt.config.json'), JSON.stringify({ ...stores.config, members: [{ id: 'owner', name: 'owner', role: 'owner' }, { id: 'keeper', name: 'keeper', role: 'maintainer' }, { id: 'dev', name: 'dev', role: 'member' }] }))
  const server = await createServer({ projectDir: root, port: 0 }); servers.push(server)
  const request = async (path: string, method: string, data?: unknown, user = 'keeper') => {
    const response = await fetch(`${server.url}/api${path}`, { method, headers: { 'content-type': 'application/json', 'x-takt-user': user }, body: data === undefined ? undefined : JSON.stringify(data) })
    return { status: response.status, data: await response.json() as any }
  }
  const denied = await request('/workflows', 'POST', { id: 'QA-admin-wf', reason: '新建' }, 'dev')
  expect(denied.status).toBe(403)
  expect(denied.data.error).toContain('新建流水线需要 maintainer')
  expect((await request('/workflows', 'POST', { id: 'QA-admin-wf' })).status).toBe(400)
  expect((await request('/workflows', 'POST', { id: 'x', template: 'nope', reason: '新建' })).data.error).toContain('模板不存在：nope')

  const blank = await request('/workflows', 'POST', { id: 'QA-admin-wf', template: 'blank', title: 'QA "流水线"', reason: '新建空白' })
  expect(blank.status, JSON.stringify(blank.data)).toBe(200)
  expect(blank.data).toMatchObject({ id: 'QA-admin-wf', file: 'workflows/QA-admin-wf.workflow.ts', model: { editable: true, meta: { title: literal('QA "流水线"') } } })
  expect(blank.data.diagnostics.filter((item: { severity: string }) => item.severity === 'error')).toEqual([])
  const added = await request('/workflows/QA-admin-wf', 'PATCH', { baseRev: blank.data.rev, edits: [{ op: 'addNode', kind: 'agent', props: { id: literal('clarify'), title: literal('澄清需求'), stage: literal('main'), role: literal('pm') }, after: null }], reason: '加节点' })
  expect(added.status, JSON.stringify(added.data)).toBe(200)
  expect(added.data.model.nodes.map((node: { id: string }) => node.id)).toEqual(['clarify'])
  expect((await request('/workflows', 'POST', { id: 'QA-admin-wf', template: 'quick-fix', reason: '重复' })).status).toBe(409)

  const quick = await request('/workflows', 'POST', { id: 'hotfix', template: 'quick-fix', title: '热修', reason: '从模板添加' })
  expect(quick.status, JSON.stringify(quick.data)).toBe(200)
  expect(quick.data.model.meta).toMatchObject({ id: 'hotfix', title: literal('热修') })
  const standard = await request('/workflows', 'POST', { id: 'taktflow-standard', template: 'taktflow-standard', reason: '从模板添加' })
  expect(standard.status, JSON.stringify(standard.data)).toBe(200)
  for (const file of ['agents/pm.md', 'agents/architect.md', 'workflows/quick-fix.hooks.ts', 'workflows/taktflow-standard.hooks.ts']) await access(join(root, file))
  expect((await request('/workflows', 'GET')).data.map((item: { id: string }) => item.id).sort()).toEqual(['QA-admin-wf', 'hotfix', 'taktflow-standard'])
  expect(JSON.parse(await readFile(join(root, 'takt.config.json'), 'utf8')).workflows).toEqual(['workflows/QA-admin-wf.workflow.ts', 'workflows/hotfix.workflow.ts', 'workflows/taktflow-standard.workflow.ts'])
  const audit = await readFile(join(root, '.takt/space-events.jsonl'), 'utf8')
  expect(audit).toContain('workflow.create hotfix from quick-fix')
}, 60_000)
