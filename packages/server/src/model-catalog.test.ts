import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type { HarnessAdapter, ProviderConfig, TaktConfig } from '@taktflow/core'
import { ModelCatalog } from './model-catalog.js'
import { MODEL_CACHE_TTL } from './model-cache.js'
import { createModelsDev, enrichModel } from './model-metadata.js'
import { listProviderModels } from './provider-request.js'
import { testRuntime } from './runtime-test.js'

const dirs: string[] = []
afterEach(async () => { vi.useRealTimers(); vi.unstubAllEnvs(); await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))) })
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status })
const config = (provider: Partial<ProviderConfig> = {}): TaktConfig => ({ project: { name: '模型目录' }, workflows: [],
  providers: { ds: { protocol: 'openai-chat', preset: 'deepseek', apiKeyEnv: 'CATALOG_API_KEY', ...provider } } })
async function fixture(fetcher: typeof fetch, now?: () => number) {
  const dir = await mkdtemp(join(tmpdir(), 'takt-models-')); dirs.push(dir)
  vi.stubEnv('CATALOG_API_KEY', 'synthetic-catalog-secret')
  return { dir, catalog: new ModelCatalog(dir, fetcher, now) }
}

// 2026-11-10 models.dev/api.json 的公开片段，只保留本功能消费的字段。
const metadata = { deepseek: { api: 'https://api.deepseek.com', models: { 'deepseek-v4-pro': {
  id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', reasoning: true, tool_call: true,
  modalities: { input: ['text'], output: ['text'] }, limit: { context: 1048576, output: 393216 }, cost: { input: 0.66, output: 1.98 },
} } } }

it('OpenAI 列表过滤非对话模型，embedding 分开，按 ID 合并手填 > 发现，列成功时不再混入预设', async () => {
  const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer synthetic-catalog-secret')
    return json({ data: [{ id: 'deepseek-v4-pro', name: '上游名称', context_length: 100, reasoning: true, efforts: ['high', 'max'] },
      { id: 'text-embedding-3-small' }, { id: 'whisper-1' }, { id: 'tts-1' }, { id: 'dall-e-3' }, { id: 'image-gen' }, { id: 'moderation' }, { id: 'rerank' },
      { id: 'opaque', modalities: { output: ['audio'] } }, { id: 'opaque-vector', modalities: { output: ['embedding'] } },
      { id: 'opaque-picture', type: 'image' }, { id: 'new-chat', modalities: { input: ['text', 'image'], output: ['text'] } }] })
  })
  const { catalog } = await fixture(fetcher)
  const cfg = config()
  cfg.models = { favorite: { provider: 'ds', id: 'deepseek-v4-pro', label: '手填名称', contextWindow: 200, efforts: ['max'], defaultEffort: 'max' },
    extra: { provider: 'ds', id: 'manual-only' }, vector: { provider: 'ds', id: 'manual-vector', kind: 'embedding' }, elsewhere: { provider: 'other', id: 'ignored' } }
  const result = await catalog.provider(cfg, 'ds')
  expect(result.models.source).toBe('live')
  expect(result.models.models.map(m => m.id)).toEqual(['deepseek-v4-pro', 'new-chat', 'manual-only'])
  expect(result.models.models[0]).toMatchObject({ origin: 'manual', alias: 'favorite', label: '手填名称', contextWindow: 200, efforts: ['max'], defaultEffort: 'max' })
  expect(result.embeddings.map(m => m.id)).toEqual(['text-embedding-3-small', 'opaque-vector', 'manual-vector'])
  expect(fetcher.mock.calls[0]![0]).toBe('https://api.deepseek.com/models')
})

it.each(['https://api.anthropic.com', 'https://api.anthropic.com/v1'])('Anthropic 认证与翻页，不重复 /v1：%s', async baseURL => {
  const fetcher = vi.fn<typeof fetch>(async (url, init) => {
    expect(new URL(String(url)).pathname).toBe('/v1/models')
    expect(new Headers(init?.headers).get('x-api-key')).toBe('synthetic-catalog-secret')
    expect(new Headers(init?.headers).get('anthropic-version')).toBe('2023-06-01')
    return new URL(String(url)).searchParams.has('after_id') ? json({ data: [{ id: 'claude-opus' }], has_more: false })
      : json({ data: [{ id: 'claude-sonnet' }], has_more: true, last_id: 'claude-sonnet' })
  })
  await fixture(fetcher)
  const provider: ProviderConfig = { protocol: 'anthropic-messages', baseURL, apiKeyEnv: 'CATALOG_API_KEY' }
  expect(await listProviderModels(provider, fetcher)).toHaveLength(2)
  expect(fetcher).toHaveBeenCalledTimes(2)
  expect(String(fetcher.mock.calls[1]![0])).toContain('after_id=claude-sonnet')
  const tested = await testRuntime({ ...config(), providers: { ds: provider } }, { target: { kind: 'provider', id: 'ds' } }, async () => ({}), undefined, fetcher)
  expect(tested).toMatchObject({ ok: true, detail: '返回 2 个模型', billed: false })
})

it('Gemini v1beta 翻页与模型名规范化、生成方法过滤', async () => {
  const fetcher = vi.fn<typeof fetch>(async (url, init) => {
    expect(new URL(String(url)).pathname).toBe('/v1beta/models')
    expect(new Headers(init?.headers).get('x-goog-api-key')).toBe('synthetic-catalog-secret')
    return new URL(String(url)).searchParams.has('pageToken') ? json({ models: [{ name: 'models/gemini-pro', displayName: 'Gemini Pro', inputTokenLimit: 1000, outputTokenLimit: 50, supportedGenerationMethods: ['generateContent'] }] })
      : json({ models: [{ name: 'models/gemini-embedding', supportedGenerationMethods: ['embedContent'] }], nextPageToken: 'page2' })
  })
  const { catalog } = await fixture(fetcher)
  const cfg = config({ preset: undefined, protocol: 'gemini', baseURL: 'https://generativelanguage.googleapis.com/v1beta' })
  const result = await catalog.provider(cfg, 'ds')
  expect(result.models.models).toEqual([expect.objectContaining({ id: 'gemini-pro', label: 'Gemini Pro', contextWindow: 1000, maxOutput: 50 })])
  expect(result.embeddings[0]!.id).toBe('gemini-embedding')
  expect(fetcher).toHaveBeenCalledTimes(2)
})

it('401 退回预设与手填，不读取或返回上游响应中的密钥', async () => {
  const fetcher = vi.fn<typeof fetch>(async () => json({ message: 'synthetic-catalog-secret' }, 401))
  const { catalog } = await fixture(fetcher)
  const cfg = config(); cfg.models = { own: { provider: 'ds', id: 'manual' } }
  const result = await catalog.provider(cfg, 'ds')
  expect(result.models).toMatchObject({ source: 'preset', error: '列模型失败（HTTP 401）' })
  expect(result.models.models.map(m => m.id)).toContain('manual')
  expect(JSON.stringify(result)).not.toContain('synthetic-catalog-secret')
})

it('异常消息脱敏，缺少密钥不请求；格式错误退回预设', async () => {
  const fetcher = vi.fn<typeof fetch>(async () => { throw new Error('failed synthetic-catalog-secret\nHTTP 503') })
  const { catalog } = await fixture(fetcher)
  expect((await catalog.provider(config(), 'ds')).models.error).toBe('failed [REDACTED] HTTP 503')
  vi.stubEnv('CATALOG_API_KEY', '')
  expect((await catalog.provider(config(), 'ds', true)).models.error).toBe('缺少密钥 CATALOG_API_KEY')
  expect(fetcher).toHaveBeenCalledTimes(1)
  vi.stubEnv('CATALOG_API_KEY', 'synthetic-catalog-secret')
  fetcher.mockResolvedValue(json({ invalid: [] }))
  expect((await catalog.provider(config(), 'ds', true)).models).toMatchObject({ source: 'preset', error: '列模型响应格式不正确' })
})

it('10 秒超时，即使假 fetch 忽略 abort 也返回预设', async () => {
  const fetcher = vi.fn<typeof fetch>(() => new Promise(() => {}))
  const { catalog } = await fixture(fetcher)
  vi.useFakeTimers()
  const pending = catalog.provider(config(), 'ds')
  await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce())
  await vi.advanceTimersByTimeAsync(10_000)
  expect((await pending).models).toMatchObject({ source: 'preset', error: '获取模型超过 10 秒' })
})

it('缓存命中、过期后台只刷新一次、refresh 强制；地址和协议变化使缓存失效', async () => {
  let now = Date.now()
  const fetcher = vi.fn<typeof fetch>(async () => json({ data: [{ id: 'old-chat' }] }))
  const { catalog, dir } = await fixture(fetcher, () => now)
  const cfg = config()
  await catalog.provider(cfg, 'ds')
  expect((await catalog.provider(cfg, 'ds')).models.source).toBe('cache')
  expect((await new ModelCatalog(dir, fetcher, () => now).provider(cfg, 'ds')).models.source).toBe('cache')
  expect(fetcher).toHaveBeenCalledOnce()
  let release!: (value: Response) => void
  fetcher.mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
  now += MODEL_CACHE_TTL + 1
  const stale = await Promise.all([catalog.provider(cfg, 'ds'), catalog.provider(cfg, 'ds'), catalog.provider(cfg, 'ds')])
  expect(stale.every(r => r.models.source === 'cache')).toBe(true)
  expect(fetcher).toHaveBeenCalledTimes(2)
  release(json({ data: [{ id: 'new-chat' }] }))
  const fresh = await catalog.provider(cfg, 'ds', true)
  expect(fresh.models.models.find(m => m.id === 'old-chat')).toMatchObject({ deprecated: true })
  expect(fresh.models.models.find(m => m.id === 'new-chat')).not.toHaveProperty('deprecated')
  await catalog.provider(cfg, 'ds', true)
  expect(fetcher).toHaveBeenCalledTimes(3)
  const saved = await readFile(join(dir, 'cache/models/ds.json'), 'utf8')
  expect(saved).not.toContain('synthetic-catalog-secret')
  expect(saved).not.toContain('https://api.deepseek.com')
  cfg.providers!.ds!.baseURL = 'https://api.openai.com/v1'
  expect((await catalog.provider(cfg, 'ds')).models.source).toBe('live')
  cfg.providers!.ds!.protocol = 'openai-responses'
  await catalog.provider(cfg, 'ds')
  expect(fetcher).toHaveBeenCalledTimes(5)
})

it('失败不构成下架证据；超出分页上限不保存部分结果', async () => {
  const fetcher = vi.fn<typeof fetch>(async () => json({ data: [{ id: 'stable' }] }))
  const { catalog } = await fixture(fetcher)
  await catalog.provider(config(), 'ds')
  fetcher.mockResolvedValue(json({}, 401))
  await catalog.provider(config(), 'ds', true)
  expect((await catalog.provider(config(), 'ds')).models.models.find(m => m.id === 'stable')).not.toHaveProperty('deprecated')
  let page = 0
  fetcher.mockImplementation(async () => json({ data: [{ id: `page-${page}` }], has_more: true, last_id: String(++page) }))
  const result = await catalog.provider(config({ protocol: 'anthropic-messages' }), 'ds', true)
  expect(result.models.error).toContain('超过 10 页')
  expect(page).toBe(10)
  expect(result.models.models.some(m => m.id.startsWith('page-'))).toBe(false)
})

it('models.dev 主机名优先、预设和全局唯一匹配；只补缺不覆盖', async () => {
  const fetcher = vi.fn<typeof fetch>(async () => json(metadata))
  const { catalog, dir } = await fixture(fetcher)
  const loaded = await catalog.metadata()
  const raw = { id: 'deepseek-v4-pro', label: 'deepseek-v4-pro', origin: 'discovered' as const, contextWindow: 42, toolCall: false, efforts: ['max' as const], defaultEffort: 'max' as const }
  const result = enrichModel(raw, { protocol: 'openai-chat', baseURL: 'https://api.deepseek.com/other' }, 'custom', loaded.value)
  expect(result).toMatchObject({ label: 'DeepSeek V4 Pro', contextWindow: 42, maxOutput: 393216, reasoning: true, toolCall: false, efforts: ['max'], defaultEffort: 'max', input: ['text'], price: { input: 0.66, output: 1.98 } })
  expect(enrichModel({ ...raw, efforts: undefined, defaultEffort: undefined }, { protocol: 'openai-chat', preset: 'deepseek' }, 'custom', loaded.value)).toMatchObject({ efforts: ['low', 'medium', 'high'], defaultEffort: 'medium' })
  expect(enrichModel(raw, { protocol: 'openai-chat' }, 'custom', loaded.value).label).toBe('DeepSeek V4 Pro')
  expect(enrichModel(raw, { protocol: 'openai-chat' }, 'custom', { ...metadata, other: metadata.deepseek }).label).toBe(raw.label)
  await createModelsDev(dir, fetcher)()
  expect(fetcher).toHaveBeenCalledOnce()
  const cfg = config(); cfg.models = { own: { provider: 'ds', id: raw.id, label: raw.id, reasoning: false, contextWindow: 10 } }
  expect(catalog.enrich(cfg, 'ds', catalog.fallback(cfg, 'ds'), loaded.value).models.models.find(m => m.id === raw.id)).toMatchObject({ label: raw.id, reasoning: false, contextWindow: 10 })
})

it('models.dev 拉不到时无补全数据，不抛异常', async () => {
  const { catalog } = await fixture(async () => { throw new Error('offline') })
  expect((await catalog.metadata()).value).toBeUndefined()
})

it('harness 缓存命中、过期后台去重、强制刷新、错误脱敏和 20 秒上限', async () => {
  let now = Date.now()
  const { catalog } = await fixture(async () => { throw new Error('不应联网') }, () => now)
  const listModels = vi.fn(async () => [{ id: 'gpt-5.2', label: 'GPT-5.2', origin: 'harness' as const }])
  const harness: HarnessAdapter = { id: 'codex', displayName: 'Codex', available: async () => ({ ok: true }), run: async () => ({ ok: true, finalText: '' }), listModels }
  expect((await catalog.harness(config(), harness)).source).toBe('live')
  expect((await catalog.harness(config(), harness)).source).toBe('cache')
  expect(listModels).toHaveBeenCalledOnce()
  let release!: (value: Awaited<ReturnType<typeof listModels>>) => void
  listModels.mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
  now += MODEL_CACHE_TTL + 1
  await Promise.all([catalog.harness(config(), harness), catalog.harness(config(), harness)])
  expect(listModels).toHaveBeenCalledTimes(2)
  release([])
  await catalog.harness(config(), harness, true)
  listModels.mockRejectedValueOnce(new Error('synthetic-catalog-secret failed'))
  expect((await catalog.harness(config(), harness, true)).error).toBe('[REDACTED] failed')
  listModels.mockImplementationOnce(() => new Promise(() => {}))
  vi.useFakeTimers()
  const pending = catalog.harness(config(), harness, true)
  await vi.waitFor(() => expect(listModels).toHaveBeenCalledTimes(4))
  await vi.advanceTimersByTimeAsync(20_000)
  expect((await pending).error).toBe('获取模型超过 20 秒')
})

it('网关模型不带推理档时，借 harness 自带列表里同名模型报的档（多个 harness 取并集），[1m] 后缀与大小写不算区别', async () => {
  const fetcher = vi.fn<typeof fetch>(async () => json({ data: [{ id: 'GPT-6-Astra[1m]' }, { id: 'gpt-6-astra' }, { id: 'mystery-model' }, { id: 'own-levels', efforts: ['low'] }] }))
  const { catalog } = await fixture(fetcher)
  const cfg = config({ preset: undefined, baseURL: 'https://gateway.example.invalid/v1' })
  const listed = (id: string, efforts: Array<'low' | 'medium' | 'high' | 'xhigh' | 'max'>, defaultEffort?: 'medium') =>
    ({ id: 'h', displayName: 'H', available: async () => ({ ok: true }), run: async () => ({ ok: true, finalText: '' }),
      listModels: async () => [{ id, label: id, origin: 'harness' as const, reasoning: true, efforts, ...(defaultEffort ? { defaultEffort } : {}) }] }) satisfies HarnessAdapter
  await catalog.harness(cfg, { ...listed('GPT-6-Astra', ['low', 'medium', 'high', 'xhigh'], 'medium'), id: 'trae' })
  await catalog.harness(cfg, { ...listed('gpt-6-astra', ['low', 'max']), id: 'codex' })
  await catalog.harness(cfg, { ...listed('own-levels', ['low', 'medium', 'high', 'max']), id: 'other' })
  const models = catalog.enrich(cfg, 'ds', await catalog.provider(cfg, 'ds')).models.models
  const byId = (id: string) => models.find(m => m.id === id)
  expect(byId('GPT-6-Astra[1m]')).toMatchObject({ efforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: 'medium' })
  expect(byId('gpt-6-astra')?.efforts).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
  // 上游自己报了档就用上游的；谁都没报过的不编造
  expect(byId('own-levels')?.efforts).toEqual(['low'])
  expect(byId('mystery-model')?.efforts).toBeUndefined()
})
