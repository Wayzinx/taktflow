import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { afterEach, expect, it, vi } from 'vitest'
import { initProject, type HarnessAdapter, type HarnessInfo, type RuntimeCatalog } from '@taktflow/core'
import { routes, type RequestContext } from './routes.js'
import type { ServerOptions } from './index.js'

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
