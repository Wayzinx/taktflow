import type { ProviderConfig } from '@taktflow/core'

export interface ProviderPreset {
  protocol: ProviderConfig['protocol']
  baseURL: string | undefined
  apiKeyEnv?: string
  /** 同一把密钥能走的其他协议入口（只登记核实过的）。 */
  endpoints?: ProviderConfig['endpoints']
  models: readonly string[]
}

export const PROVIDER_PRESETS = {
  // https://platform.openai.com/docs/api-reference/introduction
  openai: { protocol: 'openai-chat', baseURL: 'https://api.openai.com/v1', apiKeyEnv: 'OPENAI_API_KEY', endpoints: { 'openai-responses': 'https://api.openai.com/v1' }, models: ['gpt-4.1', 'gpt-4o'] },
  // https://docs.anthropic.com/en/api/messages
  anthropic: { protocol: 'anthropic-messages', baseURL: 'https://api.anthropic.com', apiKeyEnv: 'ANTHROPIC_API_KEY', models: ['claude-sonnet-4-5'] },
  // https://api-docs.deepseek.com/
  // anthropic 入口：/models 的 api_capabilities.anthropic_messages，2026-11-09 用 Claude Code 实测
  deepseek: { protocol: 'openai-chat', baseURL: 'https://api.deepseek.com', apiKeyEnv: 'DEEPSEEK_API_KEY',
    endpoints: { 'anthropic-messages': 'https://api.deepseek.com/anthropic' }, models: ['deepseek-flash', 'deepseek-v4-pro'] },
  // https://platform.moonshot.cn/docs/api/chat
  // https://platform.moonshot.cn/docs/guide/agent-support
  moonshot: { protocol: 'openai-chat', baseURL: 'https://api.moonshot.cn/v1', apiKeyEnv: 'MOONSHOT_API_KEY', endpoints: { 'anthropic-messages': 'https://api.moonshot.cn/anthropic' }, models: ['moonshot-v1-8k'] },
  // https://docs.bigmodel.cn/api-reference/模型-api/对话补全
  // https://docs.bigmodel.cn/cn/guide/develop/claude
  zhipu: { protocol: 'openai-chat', baseURL: 'https://open.bigmodel.cn/api/paas/v4', apiKeyEnv: 'ZHIPU_API_KEY', endpoints: { 'anthropic-messages': 'https://open.bigmodel.cn/api/anthropic' }, models: ['glm-4-plus'] },
  // https://help.aliyun.com/zh/model-studio/compatibility-of-openai-with-dashscope
  dashscope: { protocol: 'openai-chat', baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1', apiKeyEnv: 'DASHSCOPE_API_KEY', models: ['qwen-plus', 'qwen-turbo'] },
  // https://www.volcengine.com/docs/82379/1330310 （北京默认地址，模型使用用户的推理接入点）
  ark: { protocol: 'openai-chat', baseURL: 'https://ark.cn-beijing.volces.com/api/v3', apiKeyEnv: 'ARK_API_KEY', endpoints: { 'openai-responses': 'https://ark.cn-beijing.volces.com/api/v3' }, models: [] },
  // https://platform.minimax.io/docs/api-reference/text-anthropic-api
  minimax: { protocol: 'openai-chat', baseURL: 'https://api.minimax.io/v1', apiKeyEnv: 'MINIMAX_API_KEY', endpoints: { 'anthropic-messages': 'https://api.minimax.io/anthropic' }, models: ['MiniMax-M2'] },
  // https://platform.minimaxi.com/docs/api-reference/text-anthropic-api
  'minimax-cn': { protocol: 'openai-chat', baseURL: 'https://api.minimaxi.com/v1', apiKeyEnv: 'MINIMAX_API_KEY', endpoints: { 'anthropic-messages': 'https://api.minimaxi.com/anthropic' }, models: ['MiniMax-M2'] },
  // https://www.volcengine.com/docs/82379/1928261 （Coding Plan 的 Claude Code 入口）
  'ark-coding': { protocol: 'anthropic-messages', baseURL: 'https://ark.cn-beijing.volces.com/api/coding', apiKeyEnv: 'ARK_API_KEY', models: [] },
  // https://docs.siliconflow.cn/cn/api-reference/chat-completions/chat-completions
  siliconflow: { protocol: 'openai-chat', baseURL: 'https://api.siliconflow.cn/v1', apiKeyEnv: 'SILICONFLOW_API_KEY', models: ['deepseek-ai/DeepSeek-V3'] },
  // https://openrouter.ai/docs/quickstart
  // https://openrouter.ai/docs/api/reference/responses/overview
  // https://openrouter.ai/docs/guides/guides/claude-code-integration
  openrouter: { protocol: 'openai-chat', baseURL: 'https://openrouter.ai/api/v1', apiKeyEnv: 'OPENROUTER_API_KEY', endpoints: { 'openai-responses': 'https://openrouter.ai/api/v1', 'anthropic-messages': 'https://openrouter.ai/api' }, models: ['openai/gpt-4o'] },
  // https://learn.microsoft.com/azure/ai-foundry/openai/reference （资源、部署及 api-version 均由用户配置）
  'azure-openai': { protocol: 'openai-chat', baseURL: undefined, apiKeyEnv: 'AZURE_OPENAI_API_KEY', models: [] },
  // https://docs.ollama.com/api/openai-compatibility
  // https://docs.ollama.com/api/anthropic-compatibility
  ollama: { protocol: 'openai-chat', baseURL: 'http://localhost:11434/v1', endpoints: { 'anthropic-messages': 'http://localhost:11434' }, models: ['llama3.2'] },
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
    ...(preset?.endpoints || config.endpoints ? { endpoints: { ...preset?.endpoints, ...config.endpoints } } : {}),
  }
}

/** 每个 provider 补全预设（协议、地址、密钥名、其他协议入口）：校验搭配和真正调用都按补全后的配置判断。 */
export function withProviderPresets<T extends { providers?: Record<string, ProviderConfig> }>(config: T): T {
  return { ...config, providers: Object.fromEntries(Object.entries(config.providers ?? {}).map(([id, p]) => [id, providerConfig(id, p)])) }
}
