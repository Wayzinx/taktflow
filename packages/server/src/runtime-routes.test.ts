import { createServer as httpServer } from 'node:http'
import { once } from 'node:events'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it, vi } from 'vitest'
import { initProject, resolveSecret, type RuntimeConfig, type HarnessAdapter, type TaktConfig } from '@taktflow/core'
import { createServer, type ServerOptions } from './index.js'
import { configuredChat } from './knowledge-runtime.js'

const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); vi.unstubAllEnvs() })
async function fixture(extra: Partial<ServerOptions> = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'takt-runtime-http-'))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  vi.stubEnv('TAKT_SECRETS_FILE', join(dir, 'secrets/secrets.json'))
  vi.stubEnv('RUNTIME_TEST_KEY', '')
  const stores = await initProject(join(dir, 'space'))
  const config: TaktConfig = { ...stores.config, members: [{ id: 'alice', name: 'Alice', role: 'owner' }, { id: 'bob', name: 'Bob', role: 'member' }] }
  await writeFile(join(stores.projectDir, 'takt.config.json'), JSON.stringify(config))
  const server = await createServer({ projectDir: stores.projectDir, port: 0, ...extra })
  cleanups.push(() => server.close())
  const request = (path: string, method = 'GET', body?: unknown, user = 'alice') => fetch(server.url + path, { method,
    headers: { 'content-type': 'application/json', 'x-takt-user': user }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
  const view = async () => (await request('/api/space/runtime')).json() as Promise<RuntimeConfig>
  const patch = async (input: object) => request('/api/space/runtime', 'PATCH', { baseRevision: (await view()).revision, reason: '  保留原因  ', ...input })
  return { stores, config, request, view, patch }
}
async function fakeProvider() {
  const calls: Array<{ method: string; path: string; authorization?: string; payload: unknown }> = []
  const server = httpServer(async (req, res) => {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(Buffer.from(chunk))
    const raw = Buffer.concat(chunks).toString()
    calls.push({ method: req.method!, path: req.url!, authorization: req.headers.authorization, payload: raw ? JSON.parse(raw) : undefined })
    res.setHeader('content-type', 'application/json')
    if (req.url?.includes('denied')) { res.writeHead(401); res.end(JSON.stringify({ error: req.headers.authorization })); return }
    res.end(JSON.stringify(req.method === 'GET' ? { data: [{ id: 'test' }] } : {
      choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 },
    }))
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  cleanups.push(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())))
  return { calls, baseURL: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1` }
}

it('读视图预设、owner 权限、400 字段错误、409 与空密钥体约定', async () => {
  const f = await fixture()
  const initial = await f.view()
  expect(initial.presets.providers.map(p => p.displayName)).toEqual(['OpenAI', 'Anthropic', 'DeepSeek', 'Moonshot', '智谱', '阿里百炼', '火山方舟', 'MiniMax', '硅基流动', 'OpenRouter', 'Azure OpenAI', 'Ollama', 'vLLM', 'LM Studio', 'LiteLLM'])
  expect(initial.presets.acp.length).toBeGreaterThanOrEqual(8)
  expect((await f.request('/api/space/runtime', 'PATCH', { baseRevision: initial.revision, reason: 'try', roles: {} }, 'bob')).status).toBe(403)
  expect((await f.request('/api/secrets/RUNTIME_TEST_KEY', 'PUT', { value: 'synthetic' }, 'bob')).status).toBe(403)
  expect((await f.request('/api/secrets/lowercase', 'PUT', { value: 'synthetic' })).status).toBe(400)
  expect((await f.request('/api/secrets/RUNTIME_TEST_KEY', 'PUT', { value: '', reason: '空值校验' })).status).toBe(400)
  const invalid = await f.patch({ models: { wrong: { provider: 'missing', id: 'x' } } })
  expect(invalid.status).toBe(400); expect(await invalid.json()).toMatchObject({ error: expect.stringContaining('models.wrong.provider') })
  const saved = await f.patch({ roles: { dev: { harness: 'mock' } } }); expect(saved.status).toBe(200)
  expect((await f.request('/api/space/runtime', 'PATCH', { baseRevision: initial.revision, reason: 'stale', roles: {} })).status).toBe(409)
})

it('本机密钥不回传；列模型零计费、model 门禁与一次请求；管家消费同一解析函数', async () => {
  const f = await fixture()
  const provider = await fakeProvider()
  const secret = 'synthetic-http-local-credential'
  const put = await f.request('/api/secrets/RUNTIME_TEST_KEY', 'PUT', { value: secret, reason: '  配置测试密钥  ' })
  expect(put.status).toBe(200)
  expect(await put.json()).toEqual({ name: 'RUNTIME_TEST_KEY', source: 'local' })
  expect(process.env.RUNTIME_TEST_KEY).toBe('')
  expect((await f.patch({ providers: { test: { protocol: 'openai-chat', baseURL: provider.baseURL, apiKeyEnv: 'RUNTIME_TEST_KEY' } }, models: { small: { provider: 'test', id: 'test' } } })).status).toBe(200)
  const view = await f.view()
  expect(view.keys).toEqual({ RUNTIME_TEST_KEY: 'local' })
  expect(JSON.stringify(view)).not.toContain(secret)
  const probe = await f.request('/api/space/runtime/test', 'POST', { target: { kind: 'provider', id: 'test' } })
  expect(await probe.json()).toMatchObject({ ok: true, billed: false, detail: '返回 1 个模型' })
  expect(provider.calls).toHaveLength(1)
  expect(provider.calls[0]).toMatchObject({ method: 'GET', path: '/v1/models', authorization: `Bearer ${secret}` })
  for (const allowBilled of [undefined, false, 'true', 1]) {
    expect((await f.request('/api/space/runtime/test', 'POST', { target: { kind: 'model', alias: 'small' }, allowBilled })).status).toBe(400)
  }
  expect(provider.calls).toHaveLength(1)
  expect(await (await f.request('/api/space/runtime/test', 'POST', { target: { kind: 'model', alias: 'small' }, allowBilled: true })).json()).toMatchObject({ ok: true, billed: true })
  expect(provider.calls).toHaveLength(2)
  expect(provider.calls[1]).toMatchObject({ method: 'POST', payload: { max_tokens: 1, model: 'test' } })
  const runtimeStores = { ...f.stores, config: { ...f.config, providers: view.providers, models: view.models } }
  const chat = configuredChat(runtimeStores, 'small')
  expect(chat.info.configured).toBe(true)
  expect((await chat.chat!({ model: '', messages: [] })).message.content).toBe('ok')
  expect((await readFile(join(f.stores.projectDir, '.takt/space-events.jsonl'), 'utf8'))).not.toContain(secret)
  expect(await (await f.request('/api/secrets/RUNTIME_TEST_KEY', 'DELETE', { reason: '  删除测试密钥  ' })).json()).toEqual({ name: 'RUNTIME_TEST_KEY', source: 'missing' })
  expect(resolveSecret('RUNTIME_TEST_KEY')).toBeUndefined()
})

it('失败响应不回显远端正文；计费请求失败也如实标记 billed', async () => {
  const f = await fixture(); const provider = await fakeProvider()
  await f.request('/api/secrets/RUNTIME_TEST_KEY', 'PUT', { value: 'synthetic-failure-secret', reason: '失败脱敏测试' })
  await f.patch({ providers: { test: { protocol: 'openai-chat', baseURL: provider.baseURL + '/denied', apiKeyEnv: 'RUNTIME_TEST_KEY' } }, models: { small: { provider: 'test', id: 'test' } } })
  const response = await f.request('/api/space/runtime/test', 'POST', { target: { kind: 'model', alias: 'small' }, allowBilled: true })
  expect(await response.json()).toMatchObject({ ok: false, billed: true, message: expect.stringContaining('HTTP 401') })
  expect(provider.calls).toHaveLength(1)
})

it('harness 传回 detail 并脱敏；停用项不进行探测', async () => {
  const available = vi.fn(async () => ({ ok: true, detail: 'agent v1 protocol 1 synthetic-detail-secret' }))
  const harness: HarnessAdapter = { id: 'codex', displayName: 'fake', available, run: async () => ({ ok: true, finalText: '' }) }
  const f = await fixture({ resolveRuntime: async stores => ({ stores, harnesses: { codex: harness }, profiles: {}, knowledge: [] }) })
  await f.request('/api/secrets/DETAIL_KEY', 'PUT', { value: 'synthetic-detail-secret', reason: '探测脱敏测试' })
  expect(await (await f.request('/api/space/runtime/test', 'POST', { target: { kind: 'harness', id: 'codex' } })).json()).toMatchObject({ ok: true, billed: false, detail: 'agent v1 protocol 1 [REDACTED]' })
  await f.patch({ harnessOverrides: { codex: { disabled: true } } })
  expect(await (await f.request('/api/space/runtime/test', 'POST', { target: { kind: 'harness', id: 'codex' } })).json()).toMatchObject({ ok: false, billed: false, message: '本空间已停用' })
  expect(available).toHaveBeenCalledTimes(1)
})

it('prepare 在落盘前运行，激活在落盘后；遮盖配置可原样往返且审计只记键名', async () => {
  let activated = false
  const prepareRuntime = vi.fn<NonNullable<ServerOptions['prepareRuntime']>>(async (stores, next) => {
    expect(JSON.parse(await readFile(join(stores.projectDir, 'takt.config.json'), 'utf8')).harnessOverrides).toBeUndefined()
    expect(next.harnessOverrides?.codex?.command).toBe('/synthetic/new-codex')
    return () => { activated = true }
  })
  const f = await fixture({ prepareRuntime })
  const response = await f.patch({ harnessOverrides: { codex: { command: '/synthetic/new-codex', env: { NORMAL: 'normal-value' } } } })
  expect(response.status).toBe(200); expect(activated).toBe(true)
  expect((await response.json()).harnessOverrides.codex.env.NORMAL).toBe('[REDACTED]')
  const audit = await readFile(join(f.stores.projectDir, '.takt/space-events.jsonl'), 'utf8')
  expect(audit).toContain('harnessOverrides.codex'); expect(audit).not.toContain('/synthetic/new-codex'); expect(audit).not.toContain('normal-value')
})

it.each(['PUT', 'DELETE'])('密钥 %s 要求非空 reason，拒绝时不写密钥与审计', async method => {
  const f = await fixture()
  for (const reason of [undefined, '', '  ', 12, null]) {
    const response = await f.request('/api/secrets/RUNTIME_TEST_KEY', method, { value: 'synthetic-rejected', reason })
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ error: expect.stringContaining('reason') })
  }
  const empty = await f.request('/api/secrets/RUNTIME_TEST_KEY', method)
  expect(empty.status).toBe(400)
  expect(await empty.json()).toMatchObject({ error: expect.stringContaining('reason') })
  expect(resolveSecret('RUNTIME_TEST_KEY')).toBeUndefined()
  await expect(readFile(join(f.stores.taktDir, 'space-events.jsonl'))).rejects.toMatchObject({ code: 'ENOENT' })
})

it('密钥 PUT/DELETE 的空间审计保留 reason、操作者、密钥名与操作，不含密钥值', async () => {
  const f = await fixture()
  const secret = 'synthetic-audited-secret'
  for (const method of ['PUT', 'DELETE']) {
    const response = await f.request('/api/secrets/RUNTIME_TEST_KEY', method, { ...(method === 'PUT' ? { value: secret } : {}), reason: `  ${method} 原因  ` })
    expect(response.status).toBe(200)
    expect(JSON.stringify(await response.json())).not.toContain(secret)
  }
  const raw = await readFile(join(f.stores.taktDir, 'space-events.jsonl'), 'utf8')
  expect(raw).not.toContain(secret)
  const records = raw.trim().split('\n').map(line => JSON.parse(line))
  expect(records).toHaveLength(2)
  for (const [index, operation] of ['PUT', 'DELETE'].entries()) {
    expect(records[index].actor).toEqual({ type: 'human', id: 'alice' })
    const data = JSON.parse(records[index].data.message)
    expect(data.reason).toBe(`  ${operation} 原因  `)
    expect(JSON.parse(data.message)).toEqual({ name: 'RUNTIME_TEST_KEY', operation })
  }
})
