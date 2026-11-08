import { createServer as httpServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { initProject, openProject, type Risk, type StewardMessage } from '@taktflow/core'
import { createServer, type ServerOptions } from './index.js'
import { attachKnowledge, configuredChat, stewardModel } from './knowledge-runtime.js'
import { atomicWrite } from './space.js'

const cleanup: Array<() => Promise<unknown>> = []
it('W7：默认空间无模型时选择其他空间或用户指定的可用模型', async () => {
  const f = await fixture()
  const other = await initProject(join(f.root, 'configured'))
  other.config.models = { available: { provider: 'local', id: 'real-model' } }
  other.config.providers = { local: { protocol: 'openai-chat', baseURL: 'http://127.0.0.1:9/v1' } }
  other.config.steward = { harness: { harness: 'native', model: 'available' } }
  expect(stewardModel([f.stores, other], { trust: 'confirm', digestTimes: [], defaultSpace: 'shop' }).info)
    .toMatchObject({ configured: true, model: 'available' })
  delete other.config.steward
  expect(stewardModel([f.stores, other], { trust: 'confirm', digestTimes: [], harness: { harness: 'native', model: 'available' } }).info)
    .toMatchObject({ configured: true, model: 'available' })
})
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
async function fixture(options: Partial<ServerOptions> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'takt-m4-integration-'))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  const stores = await initProject(join(root, 'shop'), { layout: 'space' })
  stores.config.space = { id: 'shop' }; stores.config.workflows = []
  await atomicWrite(join(stores.projectDir, 'takt.config.json'), JSON.stringify(stores.config))
  const server = await createServer({ ...options, spacesDir: root, port: 0 })
  cleanup.push(() => server.close())
  const request = async (path: string, method = 'GET', body?: unknown) => {
    const response = await fetch(`${server.url}/api${path}`, { method, headers: { 'x-takt-user': 'alice', 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
    const result = await response.json()
    expect(response.status, JSON.stringify(result)).toBe(200)
    return result
  }
  return { root, stores, request }
}
it('正式服务接通知识库、共享目录、命令注册表和动态管家模型偏好', async () => {
  const f = await fixture()
  expect((await f.request('/server')).steward.configured).toBe(false)
  const commands = await f.request('/s/shop/commands') as Array<{ id: string }>
  expect(commands.map(c => c.id)).toEqual(expect.arrayContaining(['requirement.archive', 'config.patch', 'knowledge.create', 'knowledge.eval']))
  expect((await f.request('/s/shop/knowledge/kinds')).some((kind: { kind: string }) => kind.kind === 'rag')).toBe(true)
  await f.request('/s/shop/knowledge/bases', 'POST', { id: 'shared-docs', name: '共享文档', kind: 'rag', scope: 'shared', config: {}, reason: '测试共享目录' })
  expect((await attachKnowledge(await initProject(join(f.root, 'other'), { layout: 'space' }), f.root).kb!.get('shared-docs'))!.scope).toBe('shared')
  const config = { ...f.stores.config, providers: { local: { protocol: 'openai-chat', baseURL: 'http://127.0.0.1:9/v1' } }, models: { primary: { id: 'model-a', provider: 'local' }, preferred: { id: 'model-b', provider: 'local' } }, steward: { harness: { harness: 'native', model: 'primary' } } }
  await atomicWrite(join(f.stores.projectDir, 'takt.config.json'), JSON.stringify(config))
  await f.request('/steward/prefs', 'PUT', { trust: 'confirm', digestTimes: [], defaultSpace: 'shop' })
  expect((await f.request('/server')).steward).toMatchObject({ configured: true, model: 'primary' })
  await f.request('/steward/prefs', 'PUT', { trust: 'confirm', digestTimes: [], defaultSpace: 'shop', harness: { harness: 'native', model: 'preferred' } })
  expect((await f.request('/server')).steward).toMatchObject({ configured: true, model: 'preferred' })
  expect(stewardModel([{ ...f.stores, config }], { trust: 'confirm', digestTimes: [] }).info.model).toBe('primary')
  expect(configuredChat({ ...f.stores, config }, 'missing').info.configured).toBe(false)
})
it('站内风险数遵循用户忽略状态，离线提案撤销后可从需求 API 回读', async () => {
  const f = await fixture()
  await f.request('/s/shop/requirements', 'POST', { title: '逾期需求', start: false, dueAt: '2000-01-01T00:00:00Z', reason: '测试风险' })
  const risks = await f.request('/steward/risks') as Risk[]
  const risk = risks.find(r => r.kind === 'deadline')!
  expect(risk.state).toBe('open')
  expect((await f.request('/spaces')).find((s: { id: string }) => s.id === 'shop').risks).toBe(1)
  await f.request(`/steward/risks/${encodeURIComponent(risk.key)}/state`, 'POST', { state: 'ignored', reason: '已知演示风险' })
  expect((await f.request('/spaces')).find((s: { id: string }) => s.id === 'shop').risks).toBe(0)
  const created = await f.request('/steward/threads', 'POST', { text: '新建需求 按月份导出', context: [{ type: 'space', id: 'shop' }] })
  let message: StewardMessage | undefined
  await expect.poll(async () => {
    message = (await f.request(`/steward/threads/${created.thread.id}`)).messages.find((m: StewardMessage) => m.role === 'steward' && m.status === 'done')
    return message?.status
  }).toBe('done')
  const proposal = (await f.request('/steward/proposals')).find((p: { id: string }) => p.id === message!.proposalIds![0])
  expect((await f.request(`/steward/proposals/${proposal.id}/approve`, 'POST', { hash: proposal.hash })).status).toBe('applied')
  expect((await f.request(`/steward/proposals/${proposal.id}/undo`, 'POST', { reason: '验收撤销' })).status).toBe('reverted')
  expect((await f.request('/s/shop/requirements?archived=1')).find((r: { title: string }) => r.title === '按月份导出').status).toBe('archived')
})

it('openai-chat 适配器按别名选择真实 model id，转达复用群聊 Lead 回调并回填', async () => {
  const calls: Array<{ model: string; messages: Array<{ role: string }> }> = []
  const provider = httpServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk))
      const input = JSON.parse(Buffer.concat(chunks).toString())
      calls.push(input)
      const done = input.messages.some((message: { role: string }) => message.role === 'tool')
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({ choices: [{ finish_reason: done ? 'stop' : 'tool_calls', message: done ? { role: 'assistant', content: 'Lead 已回复。' } : {
        role: 'assistant', content: '', tool_calls: [{ id: 'delegate', type: 'function', function: { name: 'ask_lead', arguments: JSON.stringify({ spaceId: 'shop', requirementId: 'REQ-001', message: '请确认验收范围' }) } }],
      } }] }))
    })().catch(() => response.writeHead(500).end())
  })
  await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve))
  cleanup.push(() => new Promise<void>((resolve, reject) => { provider.close(error => error ? reject(error) : resolve()); provider.closeAllConnections() }))
  const authors: unknown[] = []
  const f = await fixture({ onSpaceLeadMention: async (dir, req, message) => {
    authors.push(message.author)
    await (await openProject(dir)).chat.post(req, { author: { type: 'agent', role: 'lead', harness: 'mock' }, kind: 'text', text: '已确认验收范围', replyTo: message.id })
  } })
  await f.request('/s/shop/requirements', 'POST', { id: 'REQ-001', title: '转达验收', start: false, reason: '测试转达' })
  const config = { ...f.stores.config, providers: { local: { protocol: 'openai-chat', baseURL: `http://127.0.0.1:${(provider.address() as { port: number }).port}/v1` } }, models: { assistant: { id: 'local-model-id', provider: 'local' } }, steward: { harness: { harness: 'native', model: 'assistant' } } }
  await atomicWrite(join(f.stores.projectDir, 'takt.config.json'), JSON.stringify(config))
  const thread = await f.request('/steward/threads', 'POST', { text: '请转达 Lead', context: [{ type: 'space', id: 'shop' }] })
  let message: StewardMessage | undefined
  await expect.poll(async () => {
    message = (await f.request(`/steward/threads/${thread.thread.id}`)).messages.find((m: StewardMessage) => m.role === 'steward' && m.status !== 'streaming')
    return message?.status
  }, { timeout: 5000 }).toBe('done')
  expect(calls.map(call => call.model)).toEqual(['local-model-id', 'local-model-id'])
  expect(authors).toEqual([{ type: 'agent', role: 'steward', harness: 'steward' }])
  expect(message!.delegations![0]).toMatchObject({ status: 'replied' })
})
