import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { afterEach, expect, it, vi } from 'vitest'
import { initProject } from '../../core/src/store/project.js'
import { registerStewardRoutes, createStewardDeps } from './steward-routes.js'
import { createRouter } from './router.js'
import { fail, json } from './http.js'
import { STREAMING, type Handler } from './routes.js'
import type { StewardMessage } from '../../core/src/api.js'
const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn() })
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'takt-steward-http-')); cleanup.push(() => rm(root, { recursive: true, force: true }))
  const stores = await initProject(root, { name: '商店' })
  const router = createRouter<Handler>(), registered: string[] = [], connections = new Set<() => void>()
  const registration = registerStewardRoutes((method, path, handler) => { registered.push(`${method} ${path}`); router.add(method, path, handler) }, { projectDir: root, connections })
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
it('实现协议中的全部 22 条路由，用户会话/提案/偏好/反馈隔离', async () => {
  const f = await fixture(); expect(f.registered).toHaveLength(22)
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
