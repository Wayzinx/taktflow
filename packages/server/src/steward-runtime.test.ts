import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { afterEach, expect, it, vi } from 'vitest'
import { initProject, StewardAgent, type HarnessAdapter, type HarnessRequest, type ProviderBridge, type StewardPrefs } from '@taktflow/core'
import { createStewardDeps } from './steward-routes.js'
import { stewardRuntime } from './steward-runtime.js'
import { StewardMcp } from './steward-mcp.js'
import { fail, json } from './http.js'
import { STREAMING } from './routes.js'
const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => { vi.unstubAllEnvs(); for (const fn of cleanup.splice(0).reverse()) await fn() })
const prefs: StewardPrefs = { trust: 'confirm', digestTimes: [] }
function adapter(id: string, protocols: string[], available = true, customProvider = true): HarnessAdapter {
  return { id, displayName: id, capabilities: { mcp: true, customProvider, providerProtocols: protocols },
    available: async () => ({ ok: available }), run: vi.fn(async () => ({ ok: true, finalText: 'done' })) }
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'takt-runtime-')); cleanup.push(() => rm(root, { recursive: true, force: true }))
  const stores = await initProject(root, { name: '商店' })
  stores.config.models = { good: { id: 'g', provider: 'chat' }, missing: { id: 'm', provider: 'key' }, incompatible: { id: 'i', provider: 'other' } }
  stores.config.providers = {
    chat: { protocol: 'openai-chat', baseURL: 'http://example.invalid' },
    key: { protocol: 'openai-chat', baseURL: 'http://example.invalid', apiKeyEnv: 'TAKT_M8_TEST_MISSING' },
    other: { protocol: 'unsupported', baseURL: 'http://example.invalid' },
  }
  vi.stubEnv('TAKT_M8_TEST_MISSING', '')
  const deps = createStewardDeps({ projectDir: root }, 'alice')
  const open = deps.open
  deps.open = async id => ({ ...await open(id), stores })
  const native = adapter('native', ['openai-chat', 'anthropic-messages'])
  const codex = adapter('codex', ['openai-chat', 'openai-responses'])
  const claude = adapter('claude-code', ['anthropic-messages'], false)
  // other 不接 MCP：管家用不了 takt 的工具，不该列出来
  const adapters = { native, codex, 'claude-code': claude, other: { ...adapter('other', []), capabilities: { mcp: false, customProvider: true } } }
  const mcp = new StewardMcp()
  const server = createServer((request, response) => {
    void mcp.handle({ request, response, stores, url: new URL(request.url!, 'http://localhost'), params: {} })
      .then(result => { if (result !== STREAMING) json(response, result) }, error => fail(response, error))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/steward/mcp`
  cleanup.push(async () => { mcp.close(); await new Promise<void>((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeAllConnections() }) })
  const runtime = stewardRuntime(deps, 'alice', mcp, () => url, () => adapters)
  const request = (token?: string, method = 'tools/list', params?: unknown, user?: string) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(user ? { 'x-takt-user': user } : {}) }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })
  return { root, stores, deps, adapters, mcp, runtime, request, url }
}
it('运行组合展示可用、缺密钥、协议不匹配和未安装原因，默认只认默认空间', async () => {
  const f = await fixture()
  f.stores.config.steward = { harness: { harness: 'native', model: 'good' } }
  const choices = await f.runtime.runtimeChoices!(prefs)
  const choice = (harness: string, model: string) => choices.find(c => c.harness === harness && c.model === model)!
  expect(choice('native', 'good')).toMatchObject({ available: true, isDefault: true, harnessLabel: '内置（直连模型 API）' })
  expect(choice('native', 'missing')).toMatchObject({ available: false, reason: expect.stringContaining('缺少密钥环境变量') })
  expect(choice('native', 'incompatible')).toMatchObject({ available: false, reason: expect.stringContaining('协议不匹配') })
  expect(choice('claude-code', 'good').reason).toContain('未安装')
  expect(choices.some(c => c.harness === 'other')).toBe(false)
  f.adapters['claude-code'] = adapter('claude-code', [], true, false)
  expect((await f.runtime.runtimeChoices!(prefs)).filter(c => c.harness === 'claude-code')).toMatchObject([{ model: undefined, available: true }])
  const preferred = await f.runtime.runtimeChoices!({ ...prefs, harness: { harness: 'codex', model: 'good' } })
  expect(preferred.filter(c => c.isDefault)).toMatchObject([{ harness: 'codex', model: 'good' }])
  const other = { ...f.stores, projectDir: join(f.root, 'other'), config: { ...f.stores.config, models: { good: { id: 'preferred-model', provider: 'chat' } } } }
  const visible = await f.deps.spaces(), open = f.deps.open
  f.deps.spaces = async () => [...visible, { ...visible[0]!, id: 'preferred' }]
  f.deps.open = async id => id === 'preferred' ? { ...await open(visible[0]!.id), stores: other } : open(id)
  const selected = await f.runtime.runtimeChoices!({ ...prefs, defaultSpace: 'preferred' })
  expect(selected.filter(c => c.harness === 'native')).toMatchObject([{ model: 'good', modelLabel: 'preferred-model', spaceId: 'preferred' }])
})
it('匹配备用 provider 协议，runtime 校验与 native 会话选择优先于偏好', async () => {
  const f = await fixture()
  f.stores.config.providers!.chat!.endpoints = { 'anthropic-messages': 'http://example.invalid/anthropic' }
  f.adapters['claude-code'] = adapter('claude-code', ['anthropic-messages'])
  const choices = await f.runtime.runtimeChoices!(prefs)
  expect(choices.find(c => c.harness === 'claude-code' && c.model === 'good')?.available).toBe(true)
  // 能换 provider 的 harness 也列出"自带模型"，排在空间模型前面
  expect(choices.filter(c => c.harness === 'claude-code')[0]).toMatchObject({ model: undefined, modelLabel: expect.stringContaining('自带模型'), available: true })
  await expect(f.runtime.resolveRuntime!(prefs, { harness: 'native', model: 'missing' })).rejects.toMatchObject({ status: 400 })
  await expect(f.runtime.resolveRuntime!(prefs, { harness: 'unknown' })).rejects.toMatchObject({ status: 400 })
  const native = await f.runtime.resolveRuntime!({ ...prefs, harness: { harness: 'codex', model: 'good' } }, { model: 'good' })
  expect(native.chat).toBeTypeOf('function'); expect(native.model).toBe('good'); expect(native.run).toBeUndefined()
})
it('协议对不上的外部 harness 经协议桥：列为可用并标出桥接，每轮开一条路由、结束就关', async () => {
  const f = await fixture()
  f.adapters.codex = adapter('codex', ['openai-responses'])
  const direct = await f.runtime.runtimeChoices!(prefs)
  expect(direct.find(c => c.harness === 'codex' && c.model === 'good')).toMatchObject({ available: false, reason: expect.stringContaining('协议不匹配') })
  const close = vi.fn(async () => {})
  const open = vi.fn<ProviderBridge['open']>(async (target, accept) => ({ provider: { id: target.id, protocol: accept, baseURL: 'http://127.0.0.1:1/bridge', apiKeyEnv: 'TAKT_BRIDGE_TOKEN' }, env: { TAKT_BRIDGE_TOKEN: 'one-time' }, close }))
  const bridge: ProviderBridge = { supports: (accept, upstream) => accept === 'openai-responses' && upstream === 'openai-chat', open, close: async () => {} }
  const runtime = stewardRuntime(f.deps, 'alice', f.mcp, () => f.url, () => f.adapters, bridge)
  const choices = await runtime.runtimeChoices!(prefs)
  expect(choices.find(c => c.harness === 'codex' && c.model === 'good')).toMatchObject({ available: true, pairing: { mode: 'bridge', protocol: 'openai-responses', upstream: 'openai-chat' } })
  expect(choices.find(c => c.harness === 'codex' && c.model === undefined)).toMatchObject({ available: true, pairing: { mode: 'builtin' } })
  expect(choices.find(c => c.harness === 'native' && c.model === 'good')?.pairing).toBeUndefined()
  const { run } = await runtime.resolveRuntime!(prefs, { harness: 'codex', model: 'good' })
  await run!({ threadId: 'thread-a', messages: [{ role: 'user', content: '你好' }], specs: [], call: async () => ({}), onEvent: () => {} })
  expect(open).toHaveBeenCalledWith(expect.objectContaining({ id: 'chat', protocol: 'openai-chat' }), 'openai-responses', { model: 'g' })
  expect(vi.mocked(f.adapters.codex.run).mock.calls[0]![0]).toMatchObject({ model: 'g', provider: { protocol: 'openai-responses', baseURL: 'http://127.0.0.1:1/bridge' }, env: { TAKT_BRIDGE_TOKEN: 'one-time' } })
  expect(close).toHaveBeenCalledOnce()
})
it('MCP initialize/list/call 往返、用户与会话绑定、过期与非本机拒绝', async () => {
  const f = await fixture(), call = vi.fn(async () => ({ done: true }))
  const grant = f.mcp.issue({ userId: 'alice', threadId: 'thread-a', specs: [{ name: 'query', description: '查询', parameters: { type: 'object' } }], call })
  expect((await f.request()).status).toBe(401)
  expect((await f.request(grant.token, 'tools/list', undefined, 'bob')).status).toBe(403)
  expect(await (await f.request(grant.token, 'initialize')).json()).toMatchObject({ result: { capabilities: { tools: {} } } })
  expect((await f.request(grant.token, 'notifications/initialized')).status).toBe(202)
  expect(await (await f.request(grant.token)).json()).toMatchObject({ result: { tools: [{ name: 'query', inputSchema: { type: 'object' } }] } })
  expect(await (await f.request(grant.token, 'tools/call', { name: 'query', threadId: 'other' })).json()).toMatchObject({ error: { code: -32602 } })
  expect(call).not.toHaveBeenCalled()
  expect(await (await f.request(grant.token, 'tools/call', { name: 'query', arguments: { x: 1 } })).json()).toMatchObject({ result: { content: [{ type: 'text', text: '{"done":true}' }] } })
  expect(call).toHaveBeenCalledWith('query', { x: 1 })
  await expect(f.mcp.handle({ request: { socket: { remoteAddress: '10.0.0.1' } } } as Parameters<typeof f.mcp.handle>[0])).rejects.toMatchObject({ status: 403 })
  grant.revoke(); expect((await f.request(grant.token)).status).toBe(401)
})
it.each([false, true])('mock harness 经真实 MCP 工具产生实体和提案，映射事件且结束即撤销令牌（失败=%s）', async failure => {
  const f = await fixture()
  let captured!: HarnessRequest
  f.adapters.codex.run = vi.fn(async (request, emit) => {
    captured = request
    const token = request.mcpServers![0]!.headers!.Authorization!.slice(7)
    const list = await (await f.request(token)).json()
    expect(list.result.tools.some((t: { name: string }) => t.name === 'show')).toBe(true)
    const space = (await f.deps.spaces())[0]!
    const shown = await (await f.request(token, 'tools/call', { name: 'show', arguments: { blocks: [{ type: 'entity', view: 'attention', ref: { type: 'space', id: space.id, spaceId: space.id } }] } })).json()
    expect(shown.result.isError).toBeUndefined()
    const proposed = await (await f.request(token, 'tools/call', { name: 'propose', arguments: { title: '记忆', summary: '用户要求', steps: [{ kind: 'file', path: 'profile.md', content: 'mock memory' }] } })).json()
    expect(proposed.result.isError).toBeUndefined()
    emit({ type: 'message', role: 'assistant', text: '已经查看' })
    emit({ type: 'tool_call', tool: 'mcp__takt__list_spaces', input: '{}', ok: true })
    return failure ? { ok: false, finalText: '', error: 'mock harness failure' } : { ok: true, finalText: '已经查看' }
  })
  Object.assign(f.deps, f.runtime)
  const agent = new StewardAgent(f.deps, 'alice')
  try {
    await agent.ready
    await agent.store.write('prefs.json', { ...prefs, harness: { harness: 'codex', model: 'good' } })
    const message = await agent.ask({ text: '帮我看看' })
    expect(message.status).toBe(failure ? 'error' : 'done')
    expect(message.proposalIds).toHaveLength(1)
    expect(message.blocks).toMatchObject([{ type: 'entity', view: 'attention' }])
    expect(captured).toMatchObject({ cwd: f.root, readOnly: true, model: 'g', mcpServers: [{ name: 'takt', url: f.url }], systemAppend: expect.any(String), prompt: expect.stringContaining('帮我看看') })
    expect(f.adapters.codex.run).toHaveBeenCalledOnce()
    expect((await f.request(captured.mcpServers![0]!.headers!.Authorization!.slice(7))).status).toBe(401)
    if (!failure) expect(message.tools).toContainEqual(expect.objectContaining({ tool: 'list_spaces', ok: true }))
    else expect(await agent.store.thread(message.threadId)).toMatchObject({ status: 'error', error: expect.stringContaining('请检查配置后重试') })
  } finally { agent.close() }
})

it('新会话第一轮直接使用请求指定的 mock harness，覆盖默认选择', async () => {
  const f = await fixture()
  const agent = new StewardAgent({ ...f.deps, ...f.runtime }, 'alice')
  try {
    const posted = await agent.post({ text: '第一轮', runtime: { harness: 'codex', model: 'good' } })
    expect(posted.thread.runtime).toEqual({ harness: 'codex', model: 'good' })
    expect((await posted.done).status).toBe('done')
    expect(f.adapters.codex.run).toHaveBeenCalledOnce()
    expect(f.adapters.native.run).not.toHaveBeenCalled()
    expect(vi.mocked(f.adapters.codex.run).mock.calls[0]![0].model).toBe('g')
  } finally { await agent.drain(); agent.close() }
})
