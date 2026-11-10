import { join } from 'node:path'
import type { CatalogModel, Effort, ProviderConfig } from '@taktflow/core'
import { ModelCache, modelDeadline } from './model-cache.js'

export const modelObject = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
const strings = (value: unknown): string[] | undefined => Array.isArray(value) && value.every(v => typeof v === 'string') ? value : undefined
const number = (value: unknown): number | undefined => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
const text = (value: unknown): string | undefined => typeof value === 'string' && value ? value : undefined
const bool = (value: unknown): boolean | undefined => typeof value === 'boolean' ? value : undefined
const efforts: Effort[] = ['low', 'medium', 'high', 'xhigh', 'max']
const effort = (value: unknown): Effort | undefined => efforts.includes(value as Effort) ? value as Effort : undefined

export function modelMetadata(raw: unknown): Partial<CatalogModel> {
  const row = modelObject(raw)
  const limit = modelObject(row.limit)
  const modalities = modelObject(row.modalities ?? row.architecture)
  const cost = modelObject(row.cost ?? row.price)
  const levels = row.efforts ?? row.supported_reasoning_levels
  const supported = Array.isArray(levels) ? [...new Set(levels.map(v => effort(typeof v === 'object' ? modelObject(v).effort : v)).filter((v): v is Effort => !!v))] : undefined
  const result: Partial<CatalogModel> = {
    label: text(row.label ?? row.display_name ?? row.displayName ?? row.name),
    contextWindow: number(row.contextWindow ?? row.context_length ?? row.context_window ?? row.inputTokenLimit ?? limit.context),
    maxOutput: number(row.maxOutput ?? row.max_output_tokens ?? row.outputTokenLimit ?? limit.output),
    reasoning: bool(row.reasoning), efforts: supported,
    defaultEffort: effort(row.defaultEffort ?? row.default_reasoning_level),
    input: strings(row.input ?? modalities.input ?? modalities.input_modalities),
    toolCall: bool(row.toolCall ?? row.tool_call),
    price: number(cost.input) !== undefined && number(cost.output) !== undefined
      ? { input: number(cost.input)!, output: number(cost.output)!, ...(number(cost.cache_read ?? cost.cachedInput) !== undefined ? { cachedInput: number(cost.cache_read ?? cost.cachedInput) } : {}) } : undefined,
  }
  return Object.fromEntries(Object.entries(result).filter(([, value]) => value !== undefined))
}

export function reasoningDefaults(model: CatalogModel): CatalogModel {
  if (!model.reasoning || model.efforts !== undefined) return model
  return { ...model, efforts: ['low', 'medium', 'high'], defaultEffort: model.defaultEffort ?? 'medium' }
}

export function modelKind(raw: unknown, id: string): 'chat' | 'embedding' | 'other' {
  const row = modelObject(raw)
  const modalities = modelObject(row.modalities ?? row.architecture)
  const output = strings(modalities.output ?? modalities.output_modalities)
  const methods = strings(row.supportedGenerationMethods)
  const kind = row.kind ?? row.type
  if (kind === 'embedding' || output?.includes('embedding') || /embed/i.test(id) || methods?.some(m => /embed/i.test(m))) return 'embedding'
  if (typeof kind === 'string' && /^(image|audio|speech|tts|moderation|rerank)$/.test(kind)) return 'other'
  if (methods && !methods.some(m => /generateContent|chat|completion/i.test(m))) return 'other'
  if (output?.length && !output.includes('text')) return 'other'
  if (/embedding|tts|whisper|dall-e|image|moderation|rerank/i.test(id)) return 'other'
  return 'chat'
}

export type ModelsDevData = Record<string, { api?: string; models: Record<string, unknown> }>
const valid = (value: unknown): value is ModelsDevData => {
  const entries = Object.values(modelObject(value))
  return entries.length > 0 && entries.every(row => {
    const models = modelObject(row).models
    return !!models && typeof models === 'object' && !Array.isArray(models)
  })
}
const hostname = (value?: string): string | undefined => { try { return value ? new URL(value).hostname : undefined } catch { return undefined } }

export function enrichModel(model: CatalogModel, provider: ProviderConfig, providerId: string, data?: ModelsDevData): CatalogModel {
  if (!data) return reasoningDefaults(model)
  const host = hostname(provider.baseURL)
  const hosts = Object.values(data).filter(p => host && hostname(p.api) === host)
  const preset = data[provider.preset ?? providerId]
  let match = hosts.map(p => p.models[model.id]).find(Boolean) ?? preset?.models[model.id]
  if (!match) {
    const matches = Object.values(data).flatMap(p => p.models[model.id] ? [p.models[model.id]] : [])
    if (matches.length === 1) match = matches[0]
  }
  if (!match) return reasoningDefaults(model)
  const metadata = modelMetadata(match)
  const own = { ...model }
  if (own.label === own.id) delete (own as Partial<CatalogModel>).label
  return reasoningDefaults({ ...metadata, ...own, label: own.label ?? metadata.label ?? model.id })
}

export function createModelsDev(taktDir: string, fetcher: typeof fetch, now?: () => number) {
  const cache = new ModelCache<ModelsDevData>(join(taktDir, 'cache/models-dev.json'), valid, now)
  return () => cache.get('models.dev/v1', () => modelDeadline(async signal => {
    const response = await fetcher('https://models.dev/api.json', { signal, redirect: 'manual' })
    if (!response.ok) { await response.body?.cancel(); throw new Error('元数据不可用') }
    const value: unknown = await response.json()
    if (!valid(value)) throw new Error('元数据不可用')
    // 只缓存补全需要的公开字段。
    return Object.fromEntries(Object.entries(value).map(([id, provider]) => [id, { api: provider.api,
      models: Object.fromEntries(Object.entries(provider.models).map(([id, model]) => [id, modelMetadata(model)])) }]))
  }, 10_000))
}
