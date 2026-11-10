import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { afterEach, expect, it, vi } from 'vitest'
import { initProject, type HarnessAdapter, type HarnessInfo, type RuntimeCatalog } from '@taktflow/core'
import { routes, type RequestContext } from './routes.js'
import type { ServerOptions } from './index.js'
import { stewardRuntime } from './steward-runtime.js'
import { createStewardDeps } from './steward-routes.js'
import { StewardMcp } from './steward-mcp.js'

const dirs: string[] = []
afterEach(async () => { vi.useRealTimers(); vi.unstubAllEnvs(); await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))) })

async function fixture(extra: Partial<ServerOptions> = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'takt-runtime-catalog-')); dirs.push(dir)
  const stores = await initProject(dir)
  stores.config.members = [{ id: 'owner', name: 'Owner', role: 'owner' }, { id: 'member', name: 'Member', role: 'member' }]
  stores.config.providers = { openai: { protocol: 'openai-chat', apiKeyEnv: 'CATALOG_API_KEY' } }
  vi.stubEnv('CATALOG_API_KEY', 'synthetic-directory-key')
  const fake: HarnessAdapter = { id: 'codex', displayName: 'Codex', capabilities: { customProvider: true, providerProtocols: ['openai-responses'] },
    available: async () => ({ ok: true }), run: async () => ({ ok: true, finalText: '' }),
    listModels: async () => [{ id: 'gpt-5.2', label: 'GPT-5.2', origin: 'harness' }] }
  const harnesses: Record<string, HarnessAdapter> = { codex: fake, mock: { ...fake, id: 'mock', listModels: undefined } }
  const infos = (): HarnessInfo[] => Object.values(harnesses).map(h => ({ id: h.id, displayName: h.displayName, source: 'builtin', available: true, capabilities: h.capabilities ?? {}, roles: [] }))
  const fetcher = vi.fn<typeof fetch>(async url => new Response(JSON.stringify(String(url).includes('models.dev') ? { openai: { api: 'https://api.openai.com', models: { 'gpt-5.2': { name: 'GPT-5.2', reasoning: true } } } } : { data: [{ id: 'gpt-5.2' }] })))
  const router = routes(new Set(), undefined, { catalogFetch: fetcher, getHarnesses: async () => infos(),
    resolveRuntime: async () => ({ stores, profiles: {}, harnesses, knowledge: [] }), ...extra })
  const request = async (path: string, method = 'GET', value?: unknown, user = 'owner') => {
    const url = new URL(path, 'http://localhost')
    const match = router.match(method, url.pathname)!
    const stream = Readable.from(value === undefined ? [] : [JSON.stringify(value)]) as IncomingMessage
    stream.headers = { 'x-takt-user': user }; stream.url = path; stream.method = method
    return match.handler({ stores, request: stream, response: {} as ServerResponse, url, params: match.params } satisfies RequestContext)
  }
  return { stores, harnesses, fetcher, request }
}

it('目录并行返回 provider/harness、补全元数据和搭配矩阵，mock 默认过滤', async () => {
  const f = await fixture()
  const catalog = await f.request('/api/space/runtime/catalog') as RuntimeCatalog
  expect(catalog.enrichment).toBe('ok')
  expect(catalog.providers[0]).toMatchObject({ id: 'openai', keyPresent: true, protocols: ['openai-chat', 'openai-responses'], models: { source: 'live' } })
  expect(catalog.providers[0]!.models.models.find(m => m.id === 'gpt-5.2')).toMatchObject({ label: 'GPT-5.2', efforts: ['low', 'medium', 'high'], defaultEffort: 'medium' })
  expect(catalog.harnesses).toHaveLength(1)
  expect(catalog.harnesses[0]).toMatchObject({ id: 'codex', icon: 'codex', ownLabel: '使用 ChatGPT 账号', accepts: ['openai-responses'], own: { source: 'live' } })
  expect(catalog.pairings).toContainEqual(expect.objectContaining({ harness: 'codex', provider: 'openai', status: 'direct' }))
  expect(await f.request('/api/harnesses')).toEqual([expect.objectContaining({ id: 'codex', testOnly: false })])
  expect(await f.request('/api/harnesses?includeTest=1')).toContainEqual(expect.objectContaining({ id: 'mock', testOnly: true }))
  expect((await f.request('/api/space/runtime/catalog?includeTest=1') as RuntimeCatalog).harnesses).toContainEqual(expect.objectContaining({ id: 'mock' }))
  expect(await f.harnesses.mock!.run({ prompt: '', cwd: f.stores.projectDir }, () => {})).toMatchObject({ ok: true })
})

it('未完成项在 3 秒内返回 preset + 正在获取，后台完成后可读缓存', async () => {
  const releases: Array<() => void> = []
  const fetcher = vi.fn<typeof fetch>(() => new Promise(resolve => { releases.push(() => resolve(new Response(JSON.stringify({ data: [{ id: 'gpt-5.2' }] })))) }))
  const f = await fixture({ catalogFetch: fetcher, getHarnesses: () => new Promise(() => {}) })
  f.harnesses.codex!.listModels = () => new Promise(resolve => { releases.push(() => resolve([])) })
  vi.useFakeTimers()
  const pending = f.request('/api/space/runtime/catalog')
  await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2))
  await vi.advanceTimersByTimeAsync(2_800)
  const result = await pending as RuntimeCatalog
  expect(result.providers[0]!.models).toMatchObject({ source: 'preset', error: '正在获取…' })
  expect(result.harnesses.find(h => h.id === 'codex')!.own).toMatchObject({ source: 'preset', error: '正在获取…' })
  expect(result.enrichment).toBe('unavailable')
  for (const release of releases) release()
  // 等后台写盘完成，再进入下次读取，避免测试清理抢占后台刷新。
  const refresh = f.request('/api/space/runtime/catalog/refresh', 'POST', { target: { kind: 'provider', id: 'openai' } })
  await vi.waitFor(() => expect(releases.length).toBeGreaterThanOrEqual(3))
  for (const release of releases) release()
  await refresh
  await vi.waitFor(async () => {
    const { readFile } = await import('node:fs/promises')
    expect(await readFile(join(f.stores.taktDir, 'cache/harness-models/codex.json'), 'utf8')).toContain('fetchedAt')
  })
})

it('refresh 需要 owner；指定项强制拉取并返回 CatalogList，错误目标拒绝', async () => {
  const f = await fixture()
  const path = '/api/space/runtime/catalog/refresh'
  const target = { kind: 'provider', id: 'openai' }
  await expect(f.request(path, 'POST', { target }, 'member')).rejects.toMatchObject({ status: 403 })
  expect(f.fetcher).not.toHaveBeenCalled()
  expect(await f.request(path, 'POST', { target })).toMatchObject({ source: 'live', models: expect.any(Array) })
  expect(await f.request(path, 'POST', { target })).toMatchObject({ source: 'live' })
  expect(f.fetcher.mock.calls.filter(([url]) => !String(url).includes('models.dev'))).toHaveLength(2)
  expect(await f.request(path, 'POST', { target: { kind: 'harness', id: 'codex' } })).toMatchObject({ source: 'live', models: [{ id: 'gpt-5.2', label: 'GPT-5.2', origin: 'harness' }] })
  await expect(f.request(path, 'POST', {})).rejects.toMatchObject({ status: 400 })
  await expect(f.request(path, 'POST', { target: { kind: 'other', id: 'openai' } })).rejects.toMatchObject({ status: 400 })
  await expect(f.request(path, 'POST', { target: { kind: 'provider', id: 'missing' } })).rejects.toMatchObject({ status: 404 })
})

it('离线补全为 unavailable，缺少密钥项不发 provider 请求', async () => {
  const fetcher = vi.fn<typeof fetch>(async () => { throw new Error('offline') })
  const f = await fixture({ catalogFetch: fetcher })
  vi.stubEnv('CATALOG_API_KEY', '')
  const result = await f.request('/api/space/runtime/catalog') as RuntimeCatalog
  expect(result.enrichment).toBe('unavailable')
  expect(result.providers[0]).toMatchObject({ keyPresent: false, models: { source: 'preset', error: '缺少密钥 CATALOG_API_KEY' } })
  expect(fetcher).toHaveBeenCalledOnce()
  expect(fetcher.mock.calls[0]![0]).toBe('https://models.dev/api.json')
})

it('目录、harness 列表、搭配与管家 choices 共享探测，测试按钮强制更新', async () => {
  const f = await fixture()
  const probe = vi.fn(async () => ({ ok: true, ownReady: true }))
  f.harnesses.codex!.available = probe
  f.harnesses.codex!.capabilities!.mcp = true
  await Promise.all([f.request('/api/space/runtime/catalog'), f.request('/api/harnesses'), f.request('/api/pairings')])
  expect(probe).toHaveBeenCalledOnce()
  const deps = createStewardDeps({ projectDir: f.stores.projectDir }, 'owner')
  const open = deps.open
  deps.open = async id => ({ ...await open(id), stores: f.stores })
  const mcp = new StewardMcp()
  try {
    const runtime = stewardRuntime(deps, 'owner', mcp, () => '', () => f.harnesses)
    const prefs = { trust: 'confirm' as const, digestTimes: [] }
    expect((await runtime.runtimeChoices!(prefs)).find(row => row.harness === 'codex')).toMatchObject({ available: true })
    await runtime.runtimeChoices!(prefs)
    expect(probe).toHaveBeenCalledOnce()
    probe.mockResolvedValue({ ok: true, ownReady: false })
    expect(await f.request('/api/space/runtime/test', 'POST', { target: { kind: 'harness', id: 'codex' } })).toMatchObject({ ok: true })
    expect(probe).toHaveBeenCalledTimes(2)
    expect((await f.request('/api/harnesses') as HarnessInfo[])[0]).toMatchObject({ ownReady: false })
    expect((await runtime.runtimeChoices!(prefs)).find(row => row.harness === 'codex' && !row.model)).toMatchObject({ available: false })
  } finally { mcp.close() }
})

it('冷目录超时后继续探测，下一次请求读取后台结果，不再等待 2.8 秒', async () => {
  const f = await fixture()
  let release!: (value: { ok: boolean }) => void
  const probe = vi.fn(() => new Promise<{ ok: boolean }>(resolve => { release = resolve }))
  f.harnesses.codex!.available = probe
  // 先热好模型目录；本场景只让可用性探测阻塞。
  await f.request('/api/space/runtime/catalog/refresh', 'POST', { target: { kind: 'provider', id: 'openai' } })
  await f.request('/api/space/runtime/catalog/refresh', 'POST', { target: { kind: 'harness', id: 'codex' } })
  vi.useFakeTimers()
  const cold = f.request('/api/space/runtime/catalog')
  await vi.waitFor(() => expect(probe).toHaveBeenCalledOnce())
  await vi.advanceTimersByTimeAsync(2_800)
  expect((await cold as RuntimeCatalog).harnesses.find(h => h.id === 'codex')).toMatchObject({ available: false, reason: '正在检测…' })
  release({ ok: true })
  await vi.advanceTimersByTimeAsync(0)
  const began = Date.now()
  expect((await f.request('/api/space/runtime/catalog') as RuntimeCatalog).harnesses.find(h => h.id === 'codex')).toMatchObject({ available: true })
  expect(Date.now() - began).toBe(0)
  expect(probe).toHaveBeenCalledOnce()
})

it('保存 harnessOverrides 和 harnesses 后重新探测，包括改回原配置', async () => {
  const f = await fixture()
  await writeFile(join(f.stores.projectDir, 'takt.config.json'), JSON.stringify(f.stores.config))
  const probe = vi.fn(async () => ({ ok: true }))
  f.harnesses.codex!.available = probe
  await f.request('/api/harnesses')
  for (const patch of [
    { harnessOverrides: { codex: { env: { SYNTHETIC: 'changed' } } } },
    { harnessOverrides: { codex: null } },
    { harnesses: { extra: { id: 'extra', kind: 'cli', command: ['synthetic-cli'], output: { format: 'text' } } } },
  ]) {
    const current = await f.request('/api/space/runtime') as { revision: string }
    await f.request('/api/space/runtime', 'PATCH', { baseRevision: current.revision, reason: '缓存失效测试', ...patch })
    await f.request('/api/harnesses')
  }
  expect(probe).toHaveBeenCalledTimes(4)
})

it('仅注入旧目录回调时列表并发去重，过期返回旧值并后台刷新', async () => {
  let release!: (value: HarnessInfo[]) => void
  const rows: HarnessInfo[] = [{ id: 'synthetic', displayName: 'Synthetic', source: 'plugin', capabilities: {}, roles: [], available: true }]
  const getHarnesses = vi.fn(async () => rows)
  const f = await fixture({ resolveRuntime: undefined, getHarnesses })
  vi.useFakeTimers()
  await Promise.all([f.request('/api/harnesses'), f.request('/api/harnesses'), f.request('/api/pairings')])
  expect(getHarnesses).toHaveBeenCalledOnce()
  getHarnesses.mockImplementation(() => new Promise(resolve => { release = resolve }))
  await vi.advanceTimersByTimeAsync(60_000)
  expect(await f.request('/api/harnesses')).toMatchObject([{ available: true }])
  expect(getHarnesses).toHaveBeenCalledTimes(2)
  release([{ ...rows[0]!, available: false, reason: 'new result' }])
  await vi.advanceTimersByTimeAsync(0)
  expect(await f.request('/api/harnesses')).toMatchObject([{ available: false, reason: 'new result' }])
})

it('统一目录保留覆盖信息，同名 env 的不同密钥均脱敏', async () => {
  const f = await fixture()
  f.stores.config.harnessOverrides = {
    codex: { env: { API_KEY: 'synthetic-first-key', NORMAL: 'visible-config-value' } },
    mock: { env: { API_KEY: 'synthetic-second-key' } },
  }
  f.harnesses.codex!.available = async () => ({ ok: false, reason: 'synthetic-first-key' })
  f.harnesses.mock!.available = async () => ({ ok: false, reason: 'synthetic-second-key' })
  const rows = await f.request('/api/harnesses?includeTest=1') as HarnessInfo[]
  expect(rows.find(row => row.id === 'codex')).toMatchObject({ override: { env: { API_KEY: '[REDACTED]', NORMAL: '[REDACTED]' } } })
  for (const value of [rows, await f.request('/api/space/runtime/catalog?includeTest=1')]) {
    expect(JSON.stringify(value)).not.toContain('synthetic-first-key')
    expect(JSON.stringify(value)).not.toContain('synthetic-second-key')
  }
})
