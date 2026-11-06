import { mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { createEngine, initProject, openProject, type LeadPresence, type Lesson, type AgentProfile } from '@taktflow/core'
import { attachLessons, createServer, type RunningServer } from './index.js'

const roots: string[] = []; const servers: RunningServer[] = []
afterEach(async () => { await Promise.all(servers.splice(0).map((server) => server.close())); await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))) })
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'takt-m3-http-')); roots.push(root)
  const stores = await initProject(root)
  stores.config.members = [{ id: 'alice', name: 'Alice', role: 'owner', duties: ['qa'] }, { id: 'bob', name: 'Bob', role: 'viewer' }]
  stores.config.repos = [{ id: 'app', path: '.', defaultBranch: 'main' }]
  await writeFile(join(root, 'takt.config.json'), JSON.stringify(stores.config))
  await writeFile(join(root, 'package.json'), '{"type":"module"}')
  await symlink(resolve('node_modules'), join(root, 'node_modules'), 'dir')
  const file = join(stores.paths.workflows, 'quick.workflow.ts')
  await writeFile(file, `import { defineWorkflow, human } from '@taktflow/core'\nexport default defineWorkflow({ id: 'quick', title: '轻量', version: '1', tiers: ['T0','T1'], stages: [], nodes: [human({ id: 'confirm', title: '确认', ask: '继续？', form: 'approve' })] })`)
  const req = await stores.workspaces.createRequirement({ title: 'src 模块修改', owner: 'alice' })
  attachLessons(stores)
  return { root, stores, req, file }
}
async function start(options: Parameters<typeof createServer>[0]) { const server = await createServer({ ...options, port: 0 }); servers.push(server); return server }
async function request(server: RunningServer, path: string, method = 'GET', value?: unknown, user?: string) {
  const response = await fetch(server.url + path, { method, headers: { 'content-type': 'application/json', ...(user ? { 'x-takt-user': user } : {}) }, body: value === undefined ? undefined : JSON.stringify(value) })
  return { status: response.status, data: await response.json() }
}

it('M3 命令、路由、经验、当前用户和仓库设置经过校验并持久化审计', async () => {
  const { root, stores, req } = await setup()
  const server = await start({ projectDir: root })
  expect((await request(server, '/api/me')).data).toMatchObject({ id: 'alice', member: { duties: ['qa'] } })
  expect((await request(server, '/api/me', 'GET', undefined, 'bob')).data.member.role).toBe('viewer')
  expect((await request(server, '/api/commands')).data.map((item: { id: string }) => item.id)).toContain('run.start')
  expect((await request(server, '/api/commands/requirement.create', 'POST', { input: { title: '无原因' } })).data.ok).toBe(false)
  expect((await request(server, '/api/commands/requirement.create', 'POST', { input: { title: '禁止' }, reason: '测试权限' }, 'bob')).data.ok).toBe(false)
  expect((await request(server, '/api/commands/requirement.create', 'POST', { input: { title: '合法需求' }, reason: '接入验证' })).data.ok).toBe(true)
  expect((await request(server, `/api/requirements/${req.id}/route`, 'POST', {})).data).toMatchObject({ tier: 'T1', workflowId: 'quick', gates: ['确认'] })
  expect((await request(server, `/api/requirements/${req.id}/route`, 'POST', { tier: 'T0' })).status).toBe(400)
  expect((await request(server, `/api/requirements/${req.id}/route`, 'POST', { tier: 'T0', reason: '给定 diff' })).data.overridden).toBeTruthy()
  const lesson: Omit<Lesson, 'createdAt' | 'updatedAt'> = { id: 'sample', title: '检查契约', body: '运行测试并保留证据', trigger: { roles: ['dev'] }, status: 'tentative', source: {}, stats: { recalled: 0, helped: 0, hurt: 0 } }
  await stores.lessons!.upsert(lesson, { type: 'human', id: 'alice' }, '录入经验')
  expect((await request(server, '/api/lessons')).data).toHaveLength(1)
  expect((await request(server, '/api/lessons/sample', 'PATCH', { status: 'active', reason: '试用通过' }, 'bob')).status).toBe(403)
  expect((await request(server, '/api/lessons/sample', 'PATCH', { status: 'active', title: '更新标题', reason: '试用通过' })).data.status).toBe('active')
  expect((await request(server, '/api/lessons?status=bad')).status).toBe(400)
  expect((await request(server, '/api/space/repos/app', 'PATCH', { bootstrap: 'npm test', share: ['node_modules'], reason: '复用依赖' })).data.repos[0]).toMatchObject({ bootstrap: 'npm test', share: ['node_modules'] })
  expect((await request(server, '/api/space/repos/app', 'PATCH', { share: ['../escape'], reason: '越界' })).status).toBe(400)
  expect((await request(server, '/api/space/members', 'PUT', { members: stores.config.members, reason: '确认职责' })).data.members[0].duties).toEqual(['qa'])
  expect((await openProject(root)).config.repos![0]!.bootstrap).toBe('npm test')
  expect(await readFile(join(stores.taktDir, 'space-events.jsonl'), 'utf8')).toContain('确认职责')
})

it('修订 GET 不写文件，初始时间取源文件 mtime，读取与移动视口不产生布局 PUT', async () => {
  const { root, stores, file } = await setup()
  const before = await readdir(stores.taktDir, { recursive: true })
  const server = await start({ projectDir: root })
  const response = await request(server, '/api/workflows/quick/revisions')
  expect(response.status).toBe(200)
  expect(response.data[0].at).toBe(new Date((await stat(file)).mtimeMs).toISOString())
  expect(await readdir(stores.taktDir, { recursive: true })).toEqual(before)
})

it('读模型返回自检、目标、预算、质量、评审处置与审批过期；cosmetic 不传播 stale', async () => {
  const { root, stores, req } = await setup()
  const profile = (role: string): AgentProfile => ({ role, title: role, description: '', instructions: '', skills: [], harness: { harness: 'mock' }, writeScope: ['**'] })
  const engine = createEngine({ stores, profiles: { dev: profile('dev'), reviewer: profile('reviewer') }, knowledge: [], harnesses: { mock: {
    id: 'mock', displayName: 'mock', capabilities: { structuredOutput: true }, available: async () => ({ ok: true }),
    run: async (input) => {
      if (input.env?.TAKT_ROLE === 'reviewer') return { ok: true, finalText: '', structured: { verdict: 'approve', summary: '仍有提示', issues: [{ id: 'minor', severity: 'minor', location: 'spec.md', description: '措辞建议' }] } }
      await writeFile(join(input.env!.TAKT_WORKSPACE!, 'spec.md'), 'AC-1：说明')
      return { ok: true, finalText: '', structured: { summary: '规格已写入', checks: [{ id: 'c1', criterion: '规格已经写入声明路径', pass: true, evidence: 'spec.md' }] } }
    },
  } } })
  const state = await engine.start({ requirementId: req.id, budget: { tokens: 10000, minutes: 10 }, workflow: { id: 'integration', title: '接入', version: '1', stages: [], nodes: [
    { id: 'write', kind: 'agent', title: '写规格', role: 'dev', goal: '明确范围', completion: ['规格已经写入声明路径'], prompt: '写规格', outputs: [{ path: 'spec.md', kind: 'spec' }] },
    { id: 'review', kind: 'review', title: '评审', needs: ['write'], author: { role: 'dev' }, reviewers: [{ role: 'reviewer' }], target: ['spec.md'], maxRounds: 1, onExhausted: 'fail' },
    { id: 'confirm', kind: 'human', title: '确认', needs: ['review'], owner: 'qa', inputs: [{ path: 'spec.md' }], ask: '确认', form: 'approve' },
  ] } })
  const server = await start({ projectDir: root })
  const detail = (await request(server, `/api/runs/${state.runId}`)).data
  expect(detail.budget.budget.tokens).toBe(10000); expect(detail.quality.verified).toBe(1)
  expect(detail.graph.nodes.find((node: { id: string }) => node.id === 'write')).toMatchObject({ goal: '明确范围', summary: '规格已写入' })
  expect((await request(server, `/api/runs/${state.runId}/nodes/write`)).data.completionChecks[0].pass).toBe(true)
  const summary = (await request(server, `/api/requirements/${req.id}`)).data
  expect(summary.current.nodeId).toBe('confirm'); expect(summary.quality.verified).toBe(1)
  const review = (await request(server, `/api/runs/${state.runId}/nodes/review`)).data.review
  expect(review.facets.coverage).toBe('full'); expect(review.revision).toBe(1)
  const groupKey = review.rounds[0].records[0].issues[0].groupKey
  const disposed = await request(server, `/api/runs/${state.runId}/nodes/review/dispositions`, 'POST', { groupKey, state: 'dismissed', reason: '保留原措辞' })
  expect(disposed.data.by).toEqual({ type: 'human', id: 'alice' })
  expect((await request(server, `/api/requirements/${req.id}/reviews`)).data[0].facets.open.minor).toBe(0)
  const pending = (await request(server, '/api/attention?pending=1')).data[0]
  expect(pending.assignees).toEqual(['alice']); expect(pending.boundTo[0].version).toBe(1)
  expect((await request(server, `/api/requirements/${req.id}/artifact?path=spec.md`, 'PUT', { content: 'AC-1：措辞', reason: '文案调整', impact: 'cosmetic' })).data.staleNodes).toEqual([])
  expect((await request(server, `/api/attention/${encodeURIComponent(pending.requestId)}`, 'POST', { decision: 'approve' })).data.boundTo[0].version).toBe(1)
  expect((await request(server, '/api/attention')).data[0].stale).toBe(true)
  const overview = (await request(server, '/api/project')).data
  expect(overview.totals).toMatchObject({ verified: 1, intercepted: 0, interceptedBy: { review: 0 } })
})

it('Room.lead 和具名 SSE lead 事件共用实时状态', async () => {
  const { root, req } = await setup()
  let presence: LeadPresence = { state: 'thinking', since: new Date().toISOString() }
  let listener: ((value: LeadPresence) => void) | undefined
  const server = await start({ projectDir: root, getLeadPresence: () => presence, subscribeLead: (_dir, _id, send) => { listener = send; return () => { listener = undefined } } })
  expect((await request(server, `/api/requirements/${req.id}/room`)).data.lead.state).toBe('thinking')
  const abort = new AbortController()
  const response = await fetch(`${server.url}/api/requirements/${req.id}/chat/stream`, { signal: abort.signal })
  const reader = response.body!.getReader()
  let text = ''
  while (!text.includes('event: lead')) text += new TextDecoder().decode((await reader.read()).value)
  expect(text).toContain('thinking')
  presence = { state: 'waiting', since: new Date().toISOString() }; listener!(presence)
  text = new TextDecoder().decode((await reader.read()).value)
  expect(text).toContain('event: lead'); expect(text).toContain('waiting')
  abort.abort()
})

it.each(['缺省', '空数组'])('成员%s的本地空间返回 owner，支持无原因路由预览及人工命令写入', async (mode) => {
  const { root, stores, req } = await setup()
  stores.config.members = mode === '缺省' ? undefined : []
  await writeFile(join(root, 'takt.config.json'), JSON.stringify(stores.config))
  const server = await start({ projectDir: root })
  for (const user of [undefined, 'demo-owner']) {
    const id = user ?? 'web'
    expect((await request(server, '/api/me', 'GET', undefined, user)).data).toEqual({ id, name: id, member: { id, name: id, role: 'owner' } })
    const route = await request(server, `/api/requirements/${req.id}/route`, 'POST', { hint: '小修复' }, user)
    expect(route).toMatchObject({ status: 200, data: { tier: 'T1', workflowId: 'quick', decidedBy: { type: 'human', id } } })
    const command = await request(server, '/api/commands/route.preview', 'POST', { input: { requirementId: req.id } }, user)
    expect(command).toMatchObject({ status: 200, data: { ok: true, result: { tier: 'T1', workflowId: 'quick' } } })
  }
  expect(await stores.runs.list()).toEqual([])
  const state = await createEngine({ stores, profiles: {}, harnesses: {}, knowledge: [] }).start({ requirementId: req.id,
    workflow: { id: 'confirm', title: '确认', version: '1', stages: [], nodes: [{ id: 'confirm', title: '确认', kind: 'human', ask: '确认继续？', form: 'approve' }] } })
  const pending = (await stores.attention.list({ pending: true })).find((item) => item.runId === state.runId)!
  const input = { requestId: pending.requestId, decision: 'approve' }
  expect((await request(server, '/api/commands/attention.answer', 'POST', { input })).data).toMatchObject({ ok: false, message: '写操作必须说明原因' })
  const answer = await request(server, '/api/commands/attention.answer', 'POST', { input, reason: '本地人工确认' })
  expect(answer.data).toMatchObject({ ok: true, result: { answeredBy: { type: 'human', id: 'web' } } })
  const reopened = await openProject(root)
  expect((await reopened.attention.list()).find((item) => item.requestId === pending.requestId)?.answeredBy).toEqual({ type: 'human', id: 'web' })
  expect(reopened.config.members).toEqual(mode === '缺省' ? undefined : [])
})

it('有成员的空间允许 viewer 预览但不提升写权限或未登记用户身份', async () => {
  const { root, stores, req } = await setup()
  const server = await start({ projectDir: root })
  expect((await request(server, '/api/me')).data.member).toMatchObject({ id: 'alice', role: 'owner' })
  expect((await request(server, '/api/me', 'GET', undefined, 'bob')).data.member.role).toBe('viewer')
  expect((await request(server, '/api/me', 'GET', undefined, 'unknown')).data).toEqual({ id: 'unknown', name: 'unknown' })
  expect((await request(server, `/api/requirements/${req.id}/route`, 'POST', { hint: '小修复' }, 'bob')).status).toBe(200)
  expect((await request(server, `/api/requirements/${req.id}/route`, 'POST', {}, 'unknown')).status).toBe(403)
  expect((await request(server, '/api/commands/requirement.create', 'POST', { input: { title: '越权写入' }, reason: '测试' }, 'bob')).data.ok).toBe(false)
  expect(await stores.runs.list()).toEqual([])
  expect(await stores.workspaces.listRequirements()).toHaveLength(1)
})

it('m3-fix 24/25：viewer 和未登记用户不能改成员/仓库/技能/审批/评测/缺陷', async () => {
  const { root, stores, req } = await setup()
  const server = await start({ projectDir: root, resolveRuntime: (fresh) => ({ stores: fresh, profiles: {}, harnesses: {}, knowledge: [] }) })
  const pending = await stores.attention.create({ requestId: 'approval', requirementId: req.id, runId: 'run-test', nodeId: 'h', ask: '批准', form: 'approve' })
  const writes: Array<[string, string, unknown]> = [
    ['/api/space/members', 'PUT', { members: [{ id: 'bob', name: 'bob', role: 'owner' }], reason: '试图提权' }],
    ['/api/space/repos/app', 'PATCH', { bootstrap: 'id', reason: '修改引导' }],
    ['/api/space/repos', 'POST', { id: 'bad', path: '.', bootstrap: 'id', reason: '添加引导' }],
    ['/api/space/files?kind=agent&name=dev', 'PUT', { content: 'unsafe', reason: '修改角色' }],
    [`/api/attention/${pending.requestId}`, 'POST', { decision: 'approve', reason: '批准' }],
    [`/api/requirements/${req.id}/defects`, 'POST', { title: 'bad', description: 'bad', severity: 'major', reason: '录入' }],
    [`/api/requirements/${req.id}/defects/D-1/attribute`, 'POST', { reason: '归因' }],
    [`/api/requirements/${req.id}/defects/D-1/confirm`, 'POST', { reason: '确认' }],
    ['/api/eval/cases/collect', 'POST', { reason: '收集' }],
    ['/api/eval/runs', 'POST', { target: { kind: 'skill', name: 'dev' }, variants: [{ id: 'baseline', label: 'baseline' }], reason: '运行' }],
  ]
  for (const user of ['bob', 'stranger']) for (const [path, method, value] of writes) {
    expect((await request(server, path, method, value, user)).status, `${user} ${path}`).toBe(403)
  }
  expect((await openProject(root)).config.members).toEqual(stores.config.members)
  expect((await stores.attention.list({ pending: true }))).toHaveLength(1)
})

it('m3-fix 24：拒绝跨站与非 JSON 写入，同源和无 Origin 可以写入', async () => {
  const { root, stores } = await setup()
  const server = await start({ projectDir: root })
  const value = JSON.stringify({ members: stores.config.members, reason: '安全回归' })
  for (const headers of [{ 'content-type': 'text/plain' }, { 'content-type': 'application/json', origin: 'https://evil.example' }, { 'content-type': 'text/plain', origin: 'null' }]) {
    const response = await fetch(server.url + '/api/space/members', { method: 'PUT', headers, body: value })
    expect([403, 415]).toContain(response.status)
  }
  for (const headers of [{ 'content-type': 'application/json' }, { 'content-type': 'application/json', origin: server.url }]) {
    expect((await fetch(server.url + '/api/space/members', { method: 'PUT', headers, body: value })).status).toBe(200)
  }
})

it('HTTP 拒绝项目外变体，评测写接口补默认 reason 并记录命令审计', async () => {
  const { root, stores, req } = await setup()
  const server = await start({ projectDir: root, resolveRuntime: (fresh) => ({ stores: fresh, profiles: {}, harnesses: {}, knowledge: [] }) })
  const outside = join(tmpdir(), 'unreadable-private-marker')
  const result = await request(server, '/api/eval/runs', 'POST', { target: { kind: 'skill', name: 'x' }, variants: [{ id: 'candidate', label: '外部', promptFile: outside }], reason: '安全回归' })
  expect(result.status).toBe(400)
  expect(result.data.error).toContain('变体路径无效')
  expect(result.data.error).not.toContain(outside)
  const input = { title: 'bug', description: 'bug', severity: 'minor' }
  expect((await request(server, `/api/requirements/${req.id}/defects`, 'POST', input)).data.id).toBe('D-1')
  expect((await request(server, `/api/requirements/${req.id}/defects`, 'POST', { ...input, reason: '独立入口回归' })).data.id).toBe('D-2')
  for (const reason of ['', ' ', null, 123]) expect((await request(server, `/api/requirements/${req.id}/defects`, 'POST', { ...input, reason })).status).toBe(400)
  const audit = await readFile(join(stores.taktDir, 'space-events.jsonl'), 'utf8')
  expect(audit).toContain('defect.report')
  expect(audit).toContain('独立入口回归')
  expect(audit).toContain('defect.report via web')
})

it('m3-fix 28/36：初始修订列表可打开和回滚，修改作者与 me 一致', async () => {
  const { root, file } = await setup()
  const original = await readFile(file, 'utf8')
  const server = await start({ projectDir: root })
  const revisions = (await request(server, '/api/workflows/quick/revisions')).data
  const rev = revisions[0].rev
  const detail = await request(server, `/api/workflows/quick/revisions/${rev}`)
  expect(detail.status).toBe(200)
  expect(detail.data).toMatchObject({ source: original, diff: '' })
  expect((await request(server, '/api/workflows/quick/rollback', 'POST', { rev, reason: '无操作回滚' })).status).toBe(200)
  expect(await readFile(file, 'utf8')).toBe(original)
  const me = (await request(server, '/api/me')).data
  expect((await request(server, '/api/workflows/quick', 'PATCH', { baseRev: rev, reason: '修改标题', edits: [{ op: 'setMeta', key: 'title', value: 'new' }] })).status).toBe(200)
  expect((await request(server, '/api/workflows/quick/revisions')).data.at(-1).author).toEqual({ type: 'human', id: me.id })
})

it('m3-fix 31：经验编辑守卫覆盖 title 和 body，拒绝后原文不变', async () => {
  const { root, stores } = await setup()
  await stores.lessons!.upsert({ id: 'guarded', title: '验证', body: '核对结果', trigger: {}, status: 'active', source: {}, stats: { recalled: 0, helped: 0, hurt: 0 } }, { type: 'human', id: 'alice' }, '初始化')
  const server = await start({ projectDir: root })
  for (const patch of [{ title: '跳过验证' }, { body: 'bypass gate' }, { body: '修改 workflow' }]) {
    expect((await request(server, '/api/lessons/guarded', 'PATCH', { ...patch, reason: '编辑' })).status).toBe(400)
  }
  expect(await stores.lessons!.get('guarded')).toMatchObject({ title: '验证', body: '核对结果' })
})

it('评测命令收敛后，录入缺陷和收集用例仍不依赖模型运行时', async () => {
  const { root, req } = await setup()
  const server = await start({ projectDir: root })
  expect((await request(server, `/api/requirements/${req.id}/defects`, 'POST', { title: '缺陷', description: '缺少边界', severity: 'minor', reason: '人工录入' })).data.id).toBe('D-1')
  expect((await request(server, '/api/eval/cases/collect', 'POST', { reason: '收集历史' })).status).toBe(200)
})
