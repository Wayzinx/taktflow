import type { ModelProvider, ProviderConfig, TaktConfig, TaktPlugin } from '@taktflow/core'
import { createProvider, providerConfig, collectSecrets, createRedactor } from '@taktflow/harness'

const nativeProtocols = new Set(['openai-chat', 'anthropic-messages'])
const knownProtocols = new Set([...nativeProtocols, 'openai-responses', 'gemini', 'bedrock', 'vertex'])
const object = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const nonempty = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0

export function normalizeConfig(config: TaktConfig): TaktConfig {
  for (const key of ['providers', 'models', 'roles'] as const) {
    if (config[key] !== undefined && !object(config[key])) throw new Error(`配置 ${key} 必须是对象`)
  }
  for (const key of ['plugins', 'workflows'] as const) {
    if (config[key] !== undefined && (!Array.isArray(config[key]) || !config[key]!.every(nonempty))) throw new Error(`配置 ${key} 必须是非空字符串数组`)
  }
  if (config.harnesses !== undefined && !Array.isArray(config.harnesses)) throw new Error('配置 harnesses 必须是数组')
  const providers: Record<string, ProviderConfig> = Object.create(null)
  for (const [id, raw] of Object.entries(config.providers ?? {})) {
    if (!nonempty(id) || !object(raw)) throw new Error(`provider ${id} 配置错误`)
    for (const key of ['protocol', 'baseURL', 'apiKeyEnv', 'preset'] as const) {
      if (raw[key] !== undefined && !nonempty(raw[key])) throw new Error(`provider ${id}: ${key} 必须是非空字符串`)
    }
    if (raw.headers !== undefined && (!object(raw.headers) || !Object.values(raw.headers).every((value) => typeof value === 'string'))) throw new Error(`provider ${id}: headers 必须是字符串映射`)
    const value = providerConfig(id, raw)
    if (!nonempty(value.protocol)) throw new Error(`provider ${id}: 缺少 protocol`)
    if (value.apiKeyEnv && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(value.apiKeyEnv)) throw new Error(`provider ${id}: apiKeyEnv 必须是环境变量名`)
    if (raw.endpoints !== undefined && (!object(raw.endpoints) || !Object.values(raw.endpoints).every(nonempty))) throw new Error(`provider ${id}: endpoints 必须是 协议 → 地址`)
    for (const [field, address] of [['baseURL', value.baseURL], ...Object.entries(value.endpoints ?? {}).map(([p, u]) => [`endpoints.${p}`, u])] as Array<[string, string | undefined]>) {
      if (address === undefined) continue
      let url: URL
      try { url = new URL(address) } catch { throw new Error(`provider ${id}: ${field} 格式错误`) }
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) throw new Error(`provider ${id}: ${field} 必须是无凭据的 HTTP(S) 地址`)
    }
    providers[id] = value
  }
  for (const [alias, model] of Object.entries(config.models ?? {})) {
    if (!nonempty(alias) || !object(model) || !nonempty(model.id) || !nonempty(model.provider)) throw new Error(`model ${alias}: 缺少 id/provider`)
    if (!Object.hasOwn(providers, model.provider)) throw new Error(`model ${alias}: provider 不存在：${model.provider}`)
    if (model.contextWindow !== undefined && (!Number.isSafeInteger(model.contextWindow) || model.contextWindow <= 0)) throw new Error(`model ${alias}: contextWindow 必须是正整数`)
    if (model.price !== undefined) {
      if (!object(model.price) || [model.price.input, model.price.output, model.price.cachedInput ?? 0].some((n) => typeof n !== 'number' || !Number.isFinite(n) || n < 0)) throw new Error(`model ${alias}: price 必须是非负有限数值`)
    }
  }
  return { ...config, providers }
}

// 插件工厂按 provider id 注册；也允许按 protocol 注册供多个配置复用，id 优先。
export function runtimeProviders(config: TaktConfig, factories: NonNullable<TaktPlugin['providers']>): Record<string, ModelProvider> {
  for (const key of Object.keys(factories)) {
    if (nativeProtocols.has(key)) throw new Error(`插件 provider 名称冲突：${key}`)
  }
  const result: Record<string, ModelProvider> = Object.create(null)
  for (const [id, value] of Object.entries(config.providers ?? {})) {
    const factory = factories[id] ?? factories[value.protocol]
    if (factory) {
      const provider = factory(value)
      if (!provider || typeof provider.chat !== 'function' || typeof provider.available !== 'function') throw new Error(`插件 provider ${id} 工厂返回值错误`)
      result[id] = { id, protocol: provider.protocol, chat: (req) => provider.chat(req), available: () => provider.available() }
    } else {
      if (!knownProtocols.has(value.protocol)) throw new Error(`provider ${id}: 未知协议 ${value.protocol}，需要插件工厂`)
      if (nativeProtocols.has(value.protocol)) {
        if (!value.baseURL) throw new Error(`provider ${id}: 缺少 baseURL`)
        result[id] = createProvider(id, value)
      }
      // Codex 等 CLI 直接消费配置；不交给只支持两种协议的 native 工厂。
    }
  }
  return result
}

export function redactConfigError(config: TaktConfig, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return createRedactor(collectSecrets(undefined, config.providers))(message)
}
