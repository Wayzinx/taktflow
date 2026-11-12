import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { afterEach, expect, it, vi } from 'vitest'
import { initProject } from '../../core/src/store/project.js'
import { registerStewardRoutes, createStewardDeps, type StewardRouteDeps } from './steward-routes.js'
import { createRouter } from './router.js'
import { fail, json } from './http.js'
import { STREAMING, type Handler } from './routes.js'
import type { StewardMessage } from '../../core/src/api.js'
const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn() })
async function fixture(onLeadMention?: StewardRouteDeps['onLeadMention']) {
  const root = await mkdtemp(join(tmpdir(), 'takt-steward-http-')); cleanup.push(() => rm(root, { recursive: true, force: true }))
  const stores = await initProject(root, { name: '商店' })
  const router = createRouter<Handler>(), registered: string[] = [], connections = new Set<() => void>()
  const registration = registerStewardRoutes((method, path, handler) => { registered.push(`${method} ${path}`); router.add(method, path, handler) }, { projectDir: root, connections, onLeadMention })
  const server = createServer((request, response) => {
    const url = new URL(request.url!, 'http://localhost')
    try {
      const found = router.match(request.method!, url.pathname)
      if (!found) { response.writeHead(404).end(); return }
      Promise.resolve(found.handler({ request, response, url, stores, params: found.params })).then((value) => { if (value !== STREAMING) json(response, value) }, (error) => fail(response, error))
    } catch (error) { fail(response, error) }
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  cleanup.push(async () => { await registration.close(); await new Promise<void>((resolve, reject) => { server.close((error) => error ? reject(error) : resolve()); server.closeAllConnections() }) })
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  const request = (path: string, user = 'alice', method = 'GET', value?: unknown) => fetch(`${base}/api/steward${path}`, { method, headers: { 'x-takt-user': user, ...(method === 'GET' ? {} : { 'content-type': 'application/json' }) }, ...(value === undefined ? {} : { body: JSON.stringify(value) }) })
  return { root, stores, registered, registration, base, request, connections }
}
it('实现协议中的管家路由与重发，用户会话/提案/偏好/反馈隔离', async () => {
  const f = await fixture(); expect(f.registered).toContain('POST /api/steward/delegations/:messageId/resend')
  const response = await f.request('/threads', 'alice', 'POST', { text: '你好' }); expect(response.status).toBe(200)
  const created = await response.json() as { thread: { id: string } }
  expect(await (await f.request('/threads', 'bob')).json()).toEqual([])
  expect((await f.request(`/threads/${created.thread.id}`, 'bob')).status).toBe(404)
  await vi.waitFor(async () => {
    const detail = await (await f.request(`/threads/${created.thread.id}`)).json() as { messages: StewardMessage[] }
    expect(detail.messages.some((m) => m.role === 'steward' && m.status === 'done')).toBe(true)
  })
  const detail = await (await f.request(`/threads/${created.thread.id}`)).json() as { messages: StewardMessage[] }
  const reply = detail.messages.find((m) => m.role === 'steward')!
  expect((await f.request(`/messages/${reply.id}/feedback`, 'bob', 'POST', { rating: 'down' })).status).toBe(404)
  expect((await f.request(`/messages/${reply.id}/feedback`, 'alice', 'POST', { rating: 'up' })).status).toBe(200)
  await f.request('/prefs', 'alice', 'PUT', { trust: 'auto-low', digestTimes: ['09:30'], defaultSpace: 'shop' })
  expect(await (await f.request('/prefs', 'bob')).json()).toEqual({ trust: 'confirm', digestTimes: ['09:30', '18:00'] })
  await f.request('/profile', 'alice', 'PUT', { content: 'alice only' })
  expect(await (await f.request('/profile', 'bob')).json()).toEqual({ content: '' })
  const agent = f.registration.agents.get('alice')!
  const p = await agent.proposals.create(created.thread.id, '记忆', '测试', [{ kind: 'file', path: 'profile.md', content: 'approved memory' }])
  expect((await f.request(`/proposals/${p.id}/approve`, 'bob', 'POST', { hash: p.hash })).status).toBe(404)
  expect(await (await f.request('/proposals', 'bob')).json()).toEqual([])
})
it('路径穿越、坏请求、非法来源和未授权空间不会进入工具', async () => {
  const f = await fixture()
  expect((await f.request('/threads', '../bob')).status).toBe(400)
  expect((await f.request('/threads', 'alice', 'POST', { text: '' })).status).toBe(400)
  expect((await f.request('/prefs', 'alice', 'PUT', { trust: 'auto-low', digestTimes: ['29:99'] })).status).toBe(400)
  expect((await f.request('/events', 'alice', 'POST', { type: 'unknown', feature: 'x' })).status).toBe(400)
  expect((await f.request('/threads/%2E%2E%2Fbob')).status).toBe(400)
  const crossOrigin = await fetch(`${f.base}/api/steward/profile`, { method: 'PUT', headers: { 'content-type': 'application/json', origin: 'https://attacker.test' }, body: '{"content":"bad"}' })
  expect(crossOrigin.status).toBe(403)
  const config = { ...f.stores.config, members: [{ id: 'alice', name: 'Alice', role: 'owner' }] }
  await writeFile(join(f.root, 'takt.config.json'), JSON.stringify(config))
  const deps = createStewardDeps({ projectDir: f.root }, 'bob')
  expect(await deps.spaces()).toEqual([])
  await expect(deps.open(f.root.split('/').at(-1)!)).rejects.toMatchObject({ status: 403 })
})
it('SSE 能在回复完成后重放持久化消息，断开会清理连接', async () => {
  const f = await fixture(), created = await (await f.request('/threads', 'alice', 'POST', { text: '你好' })).json() as { thread: { id: string } }
  await vi.waitFor(async () => expect((await f.registration.agents.get('alice')!.store.messages(created.thread.id)).some((m) => m.status === 'done' && m.role === 'steward')).toBe(true))
  const controller = new AbortController()
  const response = await fetch(`${f.base}/api/steward/threads/${created.thread.id}/stream`, { headers: { 'x-takt-user': 'alice' }, signal: controller.signal })
  expect(response.headers.get('content-type')).toContain('text/event-stream')
  const reader = response.body!.getReader(); let content = ''
  while (!content.includes('"type":"done"')) content += new TextDecoder().decode((await reader.read()).value)
  expect(content).toContain('需要先配置管家模型')
  controller.abort(); await reader.cancel().catch(() => {})
  await vi.waitFor(() => expect(f.connections.size).toBe(0))
})
it('页面事件返回 204，指标有七日趋势，全局 SSE 推送动态', async () => {
  const f = await fixture()
  expect((await f.request('/events', 'alice', 'POST', { type: 'dialog.submit', feature: 'requirement.create', ms: 100 })).status).toBe(204)
  const metrics = await (await f.request('/metrics')).json() as Array<{ feature: string; metric: string; value: number; trend: number[] }>
  expect(metrics.find((m) => m.feature === 'requirement.create' && m.metric === 'completion_ms')).toMatchObject({ value: 100, trend: expect.any(Array) })
  const controller = new AbortController(), response = await fetch(`${f.base}/api/steward/stream`, { headers: { 'x-takt-user': 'alice' }, signal: controller.signal })
  const reader = response.body!.getReader(); const first = new TextDecoder().decode((await reader.read()).value)
  expect(first).toContain('"type":"unread"')
  await f.registration.agents.get('alice')!.store.feed({ type: 'unread', at: new Date().toISOString(), count: 9 })
  expect(new TextDecoder().decode((await reader.read()).value)).toContain('"count":9')
  controller.abort(); await reader.cancel().catch(() => {})
})
it('真实命令表创建需求并撤销；新文件撤销后恢复不存在状态', async () => {
  const f = await fixture(), created = await (await f.request('/threads', 'alice', 'POST', { text: '你好' })).json() as { thread: { id: string } }
  const agent = f.registration.agents.get('alice')!, space = (await agent.deps.spaces())[0]!
  const p = await agent.proposals.create(created.thread.id, '创建需求', '测试', [{ kind: 'command', spaceId: space.id, commandId: 'requirement.create', input: { title: '草稿', start: false } }])
  expect((await f.request(`/proposals/${p.id}/approve`, 'alice', 'POST', { hash: 'bad' })).status).toBe(409)
  expect(await (await f.request(`/proposals/${p.id}/approve`, 'alice', 'POST', { hash: p.hash })).json()).toMatchObject({ status: 'applied' })
  expect(await (await f.request(`/proposals/${p.id}/undo`, 'alice', 'POST', {})).json()).toMatchObject({ status: 'reverted' })
  const file = await agent.proposals.create(created.thread.id, '创建角色', '测试', [{ kind: 'file', spaceId: space.id, path: 'agents/new.md', content: 'new' }])
  expect(await (await f.request(`/proposals/${file.id}/approve`, 'alice', 'POST', { hash: file.hash })).json()).toMatchObject({ status: 'applied' })
  expect(await readFile(join(f.root, 'agents/new.md'), 'utf8')).toBe('new')
  expect(await (await f.request(`/proposals/${file.id}/undo`, 'alice', 'POST', {})).json()).toMatchObject({ status: 'reverted' })
  await expect(readFile(join(f.root, 'agents/new.md'))).rejects.toMatchObject({ code: 'ENOENT' })
})

it('管家提案新建 workflow：带 edits 一次建好节点并预览，批准后登记、可撤销；不存在的 workflow 提示改用 workflow.create', async () => {
  const f = await fixture(), created = await (await f.request('/threads', 'alice', 'POST', { text: '你好' })).json() as { thread: { id: string } }
  const agent = f.registration.agents.get('alice')!, space = (await agent.deps.spaces())[0]!, thread = created.thread.id
  const literal = (value: unknown) => ({ kind: 'literal' as const, value })
  const edits = [
    { op: 'setStages' as const, stages: [{ id: 'design', title: '策划' }, { id: 'build', title: '制作' }] },
    { op: 'addNode' as const, kind: 'agent' as const, after: null, props: { id: literal('plan'), title: literal('玩法策划'), stage: literal('design'), role: literal('pm') } },
    { op: 'addNode' as const, kind: 'human' as const, after: 'plan', props: { id: literal('approve-plan'), title: literal('确认策划'), stage: literal('design'), needs: literal(['plan']), ask: literal('策划可以吗？') } },
  ]
  await expect(agent.proposals.create(thread, '改流程', '测试', [{ kind: 'workflow', spaceId: space.id, workflowId: 'game', baseRev: 'x', edits }])).rejects.toThrow('新建用 command workflow.create')
  await expect(agent.proposals.create(thread, '写源码', '测试', [{ kind: 'file', spaceId: space.id, path: 'workflows/game.workflow.ts', content: 'x' }])).rejects.toThrow('新建用 command workflow.create')
  await expect(agent.proposals.create(thread, '坏 edits', '测试', [{ kind: 'command', spaceId: space.id, commandId: 'workflow.create', input: { workflowId: 'game', edits: [{ op: 'setNeeds', id: 'nope', needs: [] }] } }])).rejects.toThrow('workflow 无法新建')
  const p = await agent.proposals.create(thread, '新建游戏流程', '测试', [{ kind: 'command', spaceId: space.id, commandId: 'workflow.create', input: { workflowId: 'game', title: '游戏制作', edits } }])
  expect(p).toMatchObject({ status: 'pending', risk: 'medium', previews: [{ kind: 'diff', title: '新建 workflows/game.workflow.ts' }] })
  expect(p.previews![0]!.body).toContain('确认策划')
  await expect(readFile(join(f.root, 'workflows/game.workflow.ts'))).rejects.toMatchObject({ code: 'ENOENT' })
  expect(await (await f.request(`/proposals/${p.id}/approve`, 'alice', 'POST', { hash: p.hash })).json()).toMatchObject({ status: 'applied', undoUntil: expect.any(String) })
  const workflows = (await agent.deps.open(space.id)).workflows
  expect((await workflows.get('game')).model.nodes.map((node) => node.id)).toEqual(['plan', 'approve-plan'])
  expect(JSON.parse(await readFile(join(f.root, 'takt.config.json'), 'utf8')).workflows).toContain('workflows/game.workflow.ts')
  await expect(agent.proposals.create(thread, '重复', '测试', [{ kind: 'command', spaceId: space.id, commandId: 'workflow.create', input: { workflowId: 'game' } }])).rejects.toThrow('已存在')
  expect(await (await f.request(`/proposals/${p.id}/undo`, 'alice', 'POST', {})).json()).toMatchObject({ status: 'reverted' })
  await expect(readFile(join(f.root, 'workflows/game.workflow.ts'))).rejects.toMatchObject({ code: 'ENOENT' })
  expect(JSON.parse(await readFile(join(f.root, 'takt.config.json'), 'utf8')).workflows).not.toContain('workflows/game.workflow.ts')
  const quick = await agent.proposals.create(thread, '从模板新建', '测试', [{ kind: 'command', spaceId: space.id, commandId: 'workflow.create', input: { workflowId: 'hotfix', template: 'quick-fix' } }])
  expect(quick.previews).toMatchObject([{ kind: 'text', title: '新建 workflows/hotfix.workflow.ts' }])
  expect(await (await f.request(`/proposals/${quick.id}/approve`, 'alice', 'POST', { hash: quick.hash })).json()).toMatchObject({ status: 'applied' })
  expect((await workflows.get('hotfix')).model.meta.id).toBe('hotfix')
  await readFile(join(f.root, 'agents/dev.md'))
}, 60_000)
it('M5 重发路由按用户隔离并保留理由，返回正式 replied 回执', async () => {
  const { openProject, sha256 } = await import('@taktflow/core')
  const f = await fixture(async (dir, id, message) => {
    const stores = await openProject(dir)
    await stores.chat.post(id, { author: { type: 'agent', role: 'lead', harness: 'mock' }, kind: 'text', text: '已收到重发', replyTo: message.id, receipt: { status: 'replied' } })
  })
  const req = await f.stores.workspaces.createRequirement({ title: '重发' })
  await f.request('/threads')
  const agent = f.registration.agents.get('alice')!, at = new Date().toISOString()
  const thread = await agent.store.createThread('转达', at)
  const space = (await agent.deps.spaces())[0]!
  const id = 'uncertain-original'
  await agent.store.write(`delegations/${sha256(id)}.json`, { delegation: { spaceId: space.id, requirementId: req.id, messageId: id, status: 'uncertain', at }, threadId: thread.id, text: '核对后重发', sentAt: at })
  expect((await f.request(`/delegations/${id}/resend`, 'alice', 'POST', {})).status).toBe(400)
  expect((await f.request(`/delegations/${id}/resend`, 'bob', 'POST', { reason: '其他人' })).status).toBe(409)
  const response = await f.request(`/delegations/${id}/resend`, 'alice', 'POST', { reason: '人工核对后重发' })
  expect(response.status).toBe(200)
  const result = await response.json()
  expect(result).toMatchObject({ status: 'replied', reply: '已收到重发' })
  expect(result.messageId).not.toBe(id)
  expect(await agent.store.lines('delegation-audit.jsonl')).toContainEqual(expect.objectContaining({ messageId: id, newMessageId: result.messageId, reason: '人工核对后重发' }))
  expect((await f.request(`/delegations/${result.messageId}/resend`, 'alice', 'POST', { reason: '已回复不得重发' })).status).toBe(409)
})

it('Solo find/picks 参数校验、真实快照、用户偏好与访问范围隔离', async () => {
  const f = await fixture()
  expect(f.registered).toContain('GET /api/steward/find')
  expect(f.registered).toContain('GET /api/steward/picks')
  await f.stores.workspaces.createRequirement({ id: 'REQ-002', title: '订单导出报表' })
  const spaceId = f.root.split('/').at(-1)!
  for (const path of ['/find', '/find?q=', '/find?q=%20', '/find?q=x&types=file', '/find?q=x&types=', '/find?q=x&limit=0', '/find?q=x&limit=1.5', '/find?q=x&limit=abc', '/find?q=x&space=', '/picks?limit=-1', '/picks?limit=abc', '/picks?limit=1.5']) {
    const response = await f.request(path)
    expect(response.status, path).toBe(400)
    expect(await response.text()).toMatch(/请/)
  }
  const found = await (await f.request('/find?q=req-02&types=requirement&limit=100')).json()
  expect(found).toMatchObject({ ambiguous: false, items: [{ ref: { id: 'REQ-002', spaceId }, snapshot: { title: '订单导出报表', status: '还没开始', tone: 'neutral' }, match: 'id', score: expect.any(Number) }] })
  expect((await (await f.request(`/find?q=req-02&space=${spaceId}`)).json()).items).toHaveLength(1)
  expect((await (await f.request(`/find?q=req-02&spaceId=${spaceId}`)).json()).items).toHaveLength(1)
  expect((await (await f.request('/picks')).json()).items).toMatchObject([{ ref: { id: 'REQ-002', spaceId }, reason: 'changed' }])
  await f.request('/prefs', 'alice', 'PUT', { trust: 'confirm', digestTimes: [], mutedSpaces: [spaceId] })
  expect(await (await f.request('/find?q=req-02')).json()).toEqual({ ambiguous: false, items: [] })
  expect(await (await f.request('/picks')).json()).toEqual({ items: [] })
  expect((await (await f.request('/find?q=req-02', 'bob')).json()).items).toHaveLength(1)
  expect((await (await f.request('/picks', 'bob')).json()).items).toHaveLength(1)
  await writeFile(join(f.root, 'takt.config.json'), JSON.stringify({ ...f.stores.config, members: [{ id: 'alice', name: 'Alice', role: 'owner' }] }))
  expect(await (await f.request('/find?q=req-02', 'bob')).json()).toEqual({ ambiguous: false, items: [] })
  expect(await (await f.request(`/find?q=req-02&space=${spaceId}`, 'bob')).json()).toEqual({ ambiguous: false, items: [] })
  expect(await (await f.request('/picks', 'bob')).json()).toEqual({ items: [] })
})

it('M8 会话 PATCH/DELETE 按用户隔离、归档过滤、未决提案 409', async () => {
  const f = await fixture()
  const created = await (await f.request('/threads', 'alice', 'POST', { text: '管理会话' })).json()
  const id = created.thread.id
  await f.registration.agents.get('alice')!.drain()
  for (const method of ['PATCH', 'DELETE']) expect((await f.request(`/threads/${id}`, 'bob', method, method === 'PATCH' ? { title: '坏' } : undefined)).status).toBe(404)
  expect((await f.request(`/threads/${id}`, 'alice', 'PATCH', { title: '  ' })).status).toBe(400)
  expect((await f.request(`/threads/${id}`, 'alice', 'PATCH', { runtime: { harness: 'unknown' } })).status).toBe(400)
  expect((await f.request(`/threads/${id}`, 'alice', 'PATCH', { runtime: [] })).status).toBe(400)
  const patch = await f.request(`/threads/${id}`, 'alice', 'PATCH', { title: '  已改名  ', pinned: true, archived: true, runtime: null })
  expect(await patch.json()).toMatchObject({ title: '已改名', titleEdited: true, pinnedAt: expect.any(String), archivedAt: expect.any(String), messageCount: 2 })
  expect(await (await f.request('/threads')).json()).toEqual([])
  expect(await (await f.request('/threads?archived=1')).json()).toMatchObject([{ id }])
  const agent = f.registration.agents.get('alice')!
  const proposal = await agent.proposals.create(id, '记忆', '测试', [{ kind: 'file', path: 'profile.md', content: 'value' }])
  const blocked = await f.request(`/threads/${id}`, 'alice', 'DELETE')
  expect(blocked.status).toBe(409)
  expect(await blocked.json()).toEqual({ error: '这个会话还有 1 个待决定的提案，先处理或归档' })
  await agent.proposals.reject(proposal.id, { type: 'human', id: 'alice' })
  expect((await f.request(`/threads/${id}`, 'alice', 'DELETE')).status).toBe(204)
  expect((await f.request(`/threads/${id}`)).status).toBe(404)
  expect((await f.request('/runtime-choices')).status).toBe(200)
  expect((await f.request('/mcp', 'alice', 'POST', { jsonrpc: '2.0', id: 1, method: 'tools/list' })).status).toBe(401)
})

it('M8 runtime PATCH 验证可用性并回读；启动恢复没有偏好文件的历史会话', async () => {
  const f = await fixture()
  await f.request('/threads')
  const agent = f.registration.agents.get('alice')!
  agent.deps.runtimeChoices = async () => [
    { harness: 'native', harnessLabel: '内置', model: 'ready', available: true },
    { harness: 'codex', harnessLabel: 'Codex', model: 'missing', available: false, reason: '缺少密钥环境变量，请配置后重试' },
  ]
  const thread = await agent.store.createThread('配置', new Date().toISOString())
  expect(await (await f.request(`/threads/${thread.id}`, 'alice', 'PATCH', { runtime: { model: 'ready' } })).json()).toMatchObject({ runtime: { model: 'ready' } })
  const invalid = await f.request(`/threads/${thread.id}`, 'alice', 'PATCH', { runtime: { harness: 'codex', model: 'missing' } })
  expect(invalid.status).toBe(400)
  expect(await invalid.json()).toEqual({ error: '缺少密钥环境变量，请配置后重试' })
  expect((await agent.store.thread(thread.id)).runtime).toEqual({ model: 'ready' })
  await agent.store.setStatus(thread.id, 'replying')
  await f.registration.close()
  const restarted = registerStewardRoutes(createRouter<Handler>(), { projectDir: f.root })
  cleanup.push(() => restarted.close())
  await restarted.ready
  expect((await restarted.agents.get('alice')!.store.thread(thread.id)).status).toBe('interrupted')
})

it('新建会话与 PATCH 共用 runtime 校验，不可用时不落会话，已有会话忽略请求 runtime', async () => {
  const f = await fixture()
  await f.request('/threads')
  const agent = f.registration.agents.get('alice')!
  agent.deps.runtimeChoices = async () => [
    { harness: 'codex', harnessLabel: 'Codex', model: 'ready', modelLabel: 'Ready', available: true },
    { harness: 'codex', harnessLabel: 'Codex', model: 'missing', modelLabel: 'Missing', available: false, reason: '缺少密钥，请配置后重试' },
  ]
  const selected: unknown[] = []
  agent.deps.resolveRuntime = async (_, runtime) => { selected.push(runtime); return { run: async () => '所选 harness 回复' } }
  for (const runtime of [{ harness: 'codex', model: 'missing' }, [], 'bad', { harness: 3 }, { model: false }, { extra: true }]) {
    const response = await f.request('/threads', 'alice', 'POST', { text: 'test', runtime })
    expect(response.status).toBe(400)
    if (!Array.isArray(runtime) && typeof runtime === 'object' && 'model' in runtime && runtime.model === 'missing')
      expect(await response.text()).toContain('缺少密钥')
    expect(await agent.store.threads()).toEqual([])
  }
  const runtime = { harness: 'codex', model: 'ready' }
  const response = await f.request('/threads', 'alice', 'POST', { text: '第一轮', runtime })
  expect(response.status).toBe(200)
  const created = await response.json()
  expect(created.thread.runtime).toEqual(runtime)
  await agent.drain()
  expect(selected).toEqual([runtime])
  expect((await agent.store.messages(created.thread.id)).find(m => m.role === 'steward')?.text).toBe('所选 harness 回复')
  expect((await f.request(`/threads/${created.thread.id}/messages`, 'alice', 'POST', { text: '第二轮', runtime: ['ignored'] })).status).toBe(200)
  await agent.drain()
  expect(selected).toEqual([runtime, runtime])
  expect((await agent.store.thread(created.thread.id)).runtime).toEqual(runtime)
})
