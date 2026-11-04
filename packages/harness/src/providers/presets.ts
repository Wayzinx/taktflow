import type { ProviderConfig } from '@taktflow/core'

export interface ProviderPreset {
  protocol: ProviderConfig['protocol']
  baseURL: string | undefined
  apiKeyEnv?: string
  models: readonly string[]
}

export const PROVIDER_PRESETS = {
  // https://platform.openai.com/docs/api-reference/introduction
  openai: { protocol: 'openai-chat', baseURL: 'https://api.openai.com/v1', apiKeyEnv: 'OPENAI_API_KEY', models: ['gpt-4.1', 'gpt-4o'] },
  // https://docs.anthropic.com/en/api/messages
  anthropic: { protocol: 'anthropic-messages', baseURL: 'https://api.anthropic.com', apiKeyEnv: 'ANTHROPIC_API_KEY', models: ['claude-sonnet-4-5'] },
  // https://api-docs.deepseek.com/
  deepseek: { protocol: 'openai-chat', baseURL: 'https://api.deepseek.com', apiKeyEnv: 'DEEPSEEK_API_KEY', models: ['deepseek-chat', 'deepseek-reasoner'] },
  // https://platform.moonshot.cn/docs/api/chat
  moonshot: { protocol: 'openai-chat', baseURL: 'https://api.moonshot.cn/v1', apiKeyEnv: 'MOONSHOT_API_KEY', models: ['moonshot-v1-8k'] },
  // https://docs.bigmodel.cn/api-reference/模型-api/对话补全
  zhipu: { protocol: 'openai-chat', baseURL: 'https://open.bigmodel.cn/api/paas/v4', apiKeyEnv: 'ZHIPU_API_KEY', models: ['glm-4-plus'] },
  // https://help.aliyun.com/zh/model-studio/compatibility-of-openai-with-dashscope
  dashscope: { protocol: 'openai-chat', baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1', apiKeyEnv: 'DASHSCOPE_API_KEY', models: ['qwen-plus', 'qwen-turbo'] },
  // https://www.volcengine.com/docs/82379/1330310 （北京默认地址，模型使用用户的推理接入点）
  ark: { protocol: 'openai-chat', baseURL: 'https://ark.cn-beijing.volces.com/api/v3', apiKeyEnv: 'ARK_API_KEY', models: [] },
  // MiniMax 的区域/产品入口需按部署填写，避免替用户选择。
  minimax: { protocol: 'openai-chat', baseURL: undefined, apiKeyEnv: 'MINIMAX_API_KEY', models: ['MiniMax-M2'] },
  // https://docs.siliconflow.cn/cn/api-reference/chat-completions/chat-completions
  siliconflow: { protocol: 'openai-chat', baseURL: 'https://api.siliconflow.cn/v1', apiKeyEnv: 'SILICONFLOW_API_KEY', models: ['deepseek-ai/DeepSeek-V3'] },
  // https://openrouter.ai/docs/quickstart
  openrouter: { protocol: 'openai-chat', baseURL: 'https://openrouter.ai/api/v1', apiKeyEnv: 'OPENROUTER_API_KEY', models: ['openai/gpt-4o'] },
  // https://learn.microsoft.com/azure/ai-foundry/openai/reference （资源、部署及 api-version 均由用户配置）
  'azure-openai': { protocol: 'openai-chat', baseURL: undefined, apiKeyEnv: 'AZURE_OPENAI_API_KEY', models: [] },
  // https://docs.ollama.com/api/openai-compatibility
  ollama: { protocol: 'openai-chat', baseURL: 'http://localhost:11434/v1', models: ['llama3.2'] },
  // https://docs.vllm.ai/en/latest/serving/openai_compatible_server.html （部署地址和模型由用户提供）
  vllm: { protocol: 'openai-chat', baseURL: undefined, models: [] },
  // https://lmstudio.ai/docs/developer/openai-compat
  lmstudio: { protocol: 'openai-chat', baseURL: 'http://localhost:1234/v1', models: [] },
  // https://docs.litellm.ai/docs/proxy/quick_start （代理部署地址由用户提供）
  litellm: { protocol: 'openai-chat', baseURL: undefined, models: [] },
} as const satisfies Record<string, ProviderPreset>

export type ProviderPresetId = keyof typeof PROVIDER_PRESETS

export function providerConfig(id: string, config: ProviderConfig): ProviderConfig {
  const presetId = config.preset ?? id
  const preset = Object.hasOwn(PROVIDER_PRESETS, presetId)
    ? PROVIDER_PRESETS[presetId as ProviderPresetId] as ProviderPreset : undefined
  if (config.preset && !preset) throw new Error('Unknown provider preset')
  return {
    protocol: config.protocol ?? preset?.protocol,
    baseURL: config.baseURL ?? preset?.baseURL,
    apiKeyEnv: config.apiKeyEnv ?? preset?.apiKeyEnv,
    headers: config.headers ? { ...config.headers } : undefined,
    preset: preset ? presetId : undefined,
  }
}
