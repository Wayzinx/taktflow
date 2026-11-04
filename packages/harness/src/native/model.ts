import type { ModelConfig, ModelProvider, ProviderConfig, HarnessRequest } from '@taktflow/core'

export interface NativeHarnessOptions {
  providers: Record<string, ModelProvider | ProviderConfig>
  models: Record<string, ModelConfig>
}

export function isProvider(value: ModelProvider | ProviderConfig): value is ModelProvider {
  return 'chat' in value && typeof value.chat === 'function'
}

export async function instantiate(id: string, config: ModelProvider | ProviderConfig): Promise<ModelProvider> {
  if (isProvider(config)) return config
  const { createProvider } = await import('../providers/index.js')
  return createProvider(id, config)
}

export async function selectModel(options: NativeHarnessOptions, req: HarnessRequest) {
  if (!req.model) throw new Error('Native harness requires a model or model alias')
  const alias = !req.provider && Object.hasOwn(options.models, req.model) ? options.models[req.model] : undefined
  const providerId = req.provider?.id ?? alias?.provider
  if (!providerId) throw new Error(`Cannot resolve provider for model ${req.model}; use a model alias or explicit provider`)
  const configured = Object.hasOwn(options.providers, providerId) ? options.providers[providerId] : undefined
  // 注入的 ModelProvider 是调用者明确选择的实现；连接配置覆盖只适用于配置工厂。
  const config = configured && isProvider(configured) ? configured : req.provider ?? configured
  if (!config) throw new Error(`Provider ${providerId} is not configured`)
  const modelId = req.provider ? req.model : alias!.id
  const metadata = req.provider ? req.modelConfig : alias
  return {
    providerId, modelId, provider: await instantiate(providerId, config),
    price: metadata?.price, contextWindow: metadata?.contextWindow,
  }
}
