import { join } from 'node:path'
import { collectSecrets, createRedactor, resolveSecret, sha256, type CatalogList, type CatalogModel, type HarnessAdapter, type TaktConfig } from '@taktflow/core'
import { providerConfig, PROVIDER_PRESETS } from '@taktflow/harness'
import { ModelCache, modelDeadline } from './model-cache.js'
import { createModelsDev, enrichModel, modelKind, modelMetadata, modelObject, reasoningDefaults, type ModelsDevData } from './model-metadata.js'
import { listProviderModels } from './provider-request.js'

export interface ProviderModels { models: CatalogList; embeddings: CatalogModel[] }
interface Discovered { models: CatalogModel[]; embeddings: CatalogModel[] }
const validModels = (value: unknown): value is CatalogModel[] => Array.isArray(value) && value.every(v => {
  const row = modelObject(v)
  return typeof row.id === 'string' && typeof row.label === 'string' && ['discovered', 'preset', 'manual', 'harness'].includes(String(row.origin))
})
const validProvider = (value: unknown): value is Discovered => validModels(modelObject(value).models) && validModels(modelObject(value).embeddings)

function manualModels(config: TaktConfig, providerId: string): Discovered {
  const result: Discovered = { models: [], embeddings: [] }
  for (const [alias, model] of Object.entries(config.models ?? {})) {
    if (model.provider !== providerId) continue
    const kind = modelKind(model, model.id)
    if (kind === 'other') continue
    result[kind === 'embedding' ? 'embeddings' : 'models'].push({ id: model.id, label: model.label ?? model.id,
      ...modelMetadata(model), origin: 'manual', alias })
  }
  return result
}

function mergeModels(...groups: CatalogModel[][]): CatalogModel[] {
  const models = new Map<string, CatalogModel>()
  for (const group of groups) for (const model of group) {
    const old = models.get(model.id)
    models.set(model.id, { ...old, ...model, label: model.label === model.id ? old?.label ?? model.id : model.label })
  }
  return [...models.values()]
}

export class ModelCatalog {
  private readonly providers = new Map<string, ModelCache<Discovered>>()
  private readonly harnesses = new Map<string, ModelCache<CatalogModel[]>>()
  readonly metadata: ReturnType<typeof createModelsDev>

  constructor(private readonly taktDir: string, private readonly fetcher: typeof fetch = fetch, private readonly now: () => number = Date.now) {
    this.metadata = createModelsDev(taktDir, fetcher, now)
  }

  fallback(config: TaktConfig, id: string, error?: string): ProviderModels {
    const provider = providerConfig(id, config.providers![id]!)
    const presetId = provider.preset ?? id
    const preset = Object.hasOwn(PROVIDER_PRESETS, presetId) ? PROVIDER_PRESETS[presetId as keyof typeof PROVIDER_PRESETS] : undefined
    const models: CatalogModel[] = (preset?.models ?? []).map(id => ({ id, label: id, origin: 'preset' }))
    const manual = manualModels(config, id)
    return { models: { models: mergeModels(models, manual.models), source: 'preset', ...(error ? { error } : {}) }, embeddings: manual.embeddings }
  }

  async provider(config: TaktConfig, id: string, refresh = false): Promise<ProviderModels> {
    const provider = providerConfig(id, config.providers![id]!)
    const redact = createRedactor(collectSecrets(undefined, config.providers))
    const safe = <T>(value: T): T => JSON.parse(redact(JSON.stringify(value))) as T
    const fallback = this.fallback(config, id)
    if (provider.apiKeyEnv && !resolveSecret(provider.apiKeyEnv)) return safe(this.fallback(config, id, `缺少密钥 ${provider.apiKeyEnv}`))
    let cache = this.providers.get(id)
    if (!cache) {
      cache = new ModelCache(join(this.taktDir, 'cache/models', `${encodeURIComponent(id)}.json`), validProvider, this.now)
      this.providers.set(id, cache)
    }
    const result = await cache.get(sha256(JSON.stringify([provider.baseURL, provider.protocol])), async previous => {
      const result: Discovered = { models: [], embeddings: [] }
      try {
        for (const value of await listProviderModels(provider, this.fetcher)) {
          const row = modelObject(value)
          const rawId = provider.protocol === 'gemini' ? row.name : row.id
          if (typeof rawId !== 'string' || !rawId.trim()) throw new Error('列模型响应缺少模型 ID')
          const id = provider.protocol === 'gemini' ? rawId.replace(/^models\//, '') : rawId
          const kind = modelKind(row, id)
          if (kind === 'other') continue
          const metadata = modelMetadata(row)
          if (provider.protocol === 'gemini' && !row.displayName) delete metadata.label
          result[kind === 'embedding' ? 'embeddings' : 'models'].push({ id, label: id, ...metadata, origin: 'discovered' })
        }
        for (const key of ['models', 'embeddings'] as const) {
          result[key] = mergeModels(result[key])
          const ids = new Set(result[key].map(model => model.id))
          for (const model of previous?.[key] ?? []) if (!ids.has(model.id)) result[key].push({ ...model, deprecated: true })
        }
        return safe(result)
      } catch (error) { throw new Error(redact(error instanceof Error ? error.message : '获取模型失败').replace(/\s+/g, ' ')) }
    }, refresh)
    if (!result.value) return safe({ ...fallback, models: { ...fallback.models, error: result.error } })
    const manual = manualModels(config, id)
    const { value, ...status } = result
    // 列成功就以上游为准：预设里写死的名字多半已过期，只在列不出来时兜底
    return safe({ models: { ...status, models: mergeModels(value.models, manual.models) },
      embeddings: mergeModels(value.embeddings, manual.embeddings) })
  }

  enrich(config: TaktConfig, id: string, result: ProviderModels, data?: ModelsDevData): ProviderModels {
    const provider = providerConfig(id, config.providers![id]!)
    const manual = manualModels(config, id)
    const enrich = (models: CatalogModel[], overrides: CatalogModel[]) => models.map(model => {
      const override = overrides.find(m => m.id === model.id)
      const fields = override ? modelMetadata(config.models![override.alias!]!) : {}
      return reasoningDefaults({ ...enrichModel(model, provider, id, data), ...fields })
    })
    return { models: { ...result.models, models: enrich(result.models.models, manual.models) }, embeddings: enrich(result.embeddings, manual.embeddings) }
  }

  async harness(config: TaktConfig, harness: HarnessAdapter, refresh = false): Promise<CatalogList> {
    if (!harness.listModels) return { models: [], source: 'preset', error: '此 harness 未提供自带模型列表' }
    const override = config.harnessOverrides?.[harness.id]
    if (override?.disabled) return { models: [], source: 'preset', error: '本空间已停用' }
    const custom = config.harnesses?.find(h => h.id === harness.id)
    const redact = createRedactor(collectSecrets({ prompt: '', cwd: '', env: { ...custom?.env, ...override?.env } }, config.providers))
    let cache = this.harnesses.get(harness.id)
    if (!cache) {
      cache = new ModelCache(join(this.taktDir, 'cache/harness-models', `${encodeURIComponent(harness.id)}.json`), validModels, this.now)
      this.harnesses.set(harness.id, cache)
    }
    const result = await cache.get(sha256(JSON.stringify([harness.id, override?.command, override?.env, custom])), async () => {
      try { return JSON.parse(redact(JSON.stringify(await modelDeadline(() => harness.listModels!(), 20_000)))) as CatalogModel[] }
      catch (error) { throw new Error(redact(error instanceof Error ? error.message : '获取自带模型失败').replace(/\s+/g, ' ')) }
    }, refresh)
    const { value, ...status } = result
    return JSON.parse(redact(JSON.stringify({ ...status, models: value ?? [] }))) as CatalogList
  }
}
