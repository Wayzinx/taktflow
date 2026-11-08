import { resolveSecret } from '@taktflow/core'
import type { ModelProvider, ProviderConfig } from '@taktflow/core'
import { createOpenAIChatProvider } from './openai-chat.js'
import { createAnthropicMessagesProvider } from './anthropic-messages.js'
import { providerConfig } from './presets.js'
import type { ProviderHttpOptions } from './http.js'

export { PROVIDER_PRESETS } from './presets.js'
export type { ProviderPreset, ProviderPresetId } from './presets.js'
export { createOpenAIChatProvider } from './openai-chat.js'
export { createAnthropicMessagesProvider } from './anthropic-messages.js'
export { ProviderHttpError } from './http.js'
export type { ProviderHttpOptions } from './http.js'
export type { ModelProvider, ProviderConfig, ModelConfig, ChatRequest, ChatResponse, ChatMessage, ToolCall, ToolSpec } from '@taktflow/core'

export function createProvider(id: string, config: ProviderConfig, options: ProviderHttpOptions = {}): ModelProvider {
  options = { resolveSecret, ...options }
  const resolved = providerConfig(id, config)
  switch (resolved.protocol) {
    case 'openai-chat': return createOpenAIChatProvider(id, resolved, options)
    case 'anthropic-messages': return createAnthropicMessagesProvider(id, resolved, options)
    default: throw new Error('Unsupported provider protocol; supported protocols: openai-chat, anthropic-messages')
  }
}

