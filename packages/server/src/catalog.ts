import type { HarnessInfo, ModelInfo, ProjectStores } from '@taktflow/core'

export type GetHarnesses = (stores: ProjectStores, includeTest?: boolean) => Promise<HarnessInfo[]>
export type GetModels = (stores: ProjectStores) => Promise<ModelInfo[]>
export type GetCatalog = (stores: ProjectStores, includeTest?: boolean) => Promise<{ harnesses: HarnessInfo[]; models: ModelInfo[] }>

export interface CatalogCallbacks {
  getHarnesses?: GetHarnesses
  getModels?: GetModels
  getCatalog?: GetCatalog
}

export const providerBrands: Record<string, string> = { openai: 'OpenAI', anthropic: 'Anthropic', deepseek: 'DeepSeek', moonshot: 'Moonshot', zhipu: '智谱', dashscope: '阿里百炼', ark: '火山方舟', minimax: 'MiniMax 国际', 'minimax-cn': 'MiniMax 国内', 'ark-coding': '方舟 Coding Plan', siliconflow: '硅基流动', openrouter: 'OpenRouter', 'azure-openai': 'Azure OpenAI', ollama: 'Ollama', vllm: 'vLLM', lmstudio: 'LM Studio', litellm: 'LiteLLM' }
