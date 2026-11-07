import type { ProjectStores, ServerInfo, StewardDeps, StewardPrefs } from '@taktflow/core'
import { createKnowledgeStore, createProjectSecretResolver } from '@taktflow/knowledge'
import { createOpenAIChatProvider, providerConfig } from '@taktflow/harness'

export function configuredChat(stores: ProjectStores, alias?: string): { info: ServerInfo['steward']; chat?: StewardDeps['chat'] } {
  const model = alias ? stores.config.models?.[alias] : undefined
  if (!alias) return { info: { configured: false, reason: '未配置管家模型，使用规则降级；可在管家设置中选择模型' } }
  const unavailable = (reason: string) => ({ info: { configured: false, harness: 'native', model: alias, reason } })
  if (!model) return unavailable('模型不存在，请在空间模型设置中登记后重新选择')
  const raw = stores.config.providers?.[model.provider]
  if (!raw) return unavailable('模型的 provider 不存在，请检查空间模型设置')
  const config = providerConfig(model.provider, raw)
  if (model.kind === 'embedding' || config.protocol !== 'openai-chat') return unavailable('管家需要 openai-chat 对话模型，请重新选择')
  if (!config.baseURL || config.apiKeyEnv && !process.env[config.apiKeyEnv]) return unavailable('模型地址或所需环境变量未配置，请检查模型设置')
  const provider = createOpenAIChatProvider(model.provider, config)
  return { info: { configured: true, harness: 'native', model: alias }, chat: async (request, onToken) => {
    const response = await provider.chat({ ...request, model: model.id })
    if (response.message.content) onToken?.(response.message.content)
    return response
  } }
}

export function configuredRouteModel(stores: ProjectStores): import('@taktflow/core').RouteInput['model'] | undefined {
  const chat = configuredChat(stores, stores.config.route?.harness?.model).chat
  return chat
    ? async (prompt, responseSchema) => JSON.parse((await chat({ model: '', messages: [{ role: 'user', content: prompt }], responseSchema: responseSchema as Record<string, unknown> })).message.content)
    : undefined
}

export function stewardModel(spaces: ProjectStores[], prefs: StewardPrefs): ReturnType<typeof configuredChat> {
  const preferred = spaces.find(space => space.config.space?.id === prefs.defaultSpace
    || space.projectDir.split('/').at(-1) === prefs.defaultSpace)
  const ordered = preferred ? [preferred, ...spaces.filter(space => space !== preferred)] : spaces
  const choices = ordered.map(stores => configuredChat(stores, prefs.harness?.model ?? stores.config.steward?.harness?.model))
  return choices.find(choice => choice.info.configured) ?? choices[0]
    ?? { info: { configured: false, reason: '请先新建空间并配置管家模型；当前使用规则降级' } }
}

export function attachKnowledge(stores: ProjectStores, sharedRoot?: string): ProjectStores {
  const model = configuredChat(stores, stores.config.steward?.harness?.model)
  // 工厂内部将空间根目录展开为 .shared/knowledge；嵌入配置由工厂解析，未配置时不传 embed。
  stores.kb ??= createKnowledgeStore(stores, { sharedRoot, secrets: createProjectSecretResolver(stores),
    ...(model.chat ? { chat: async (prompt: string) => (await model.chat!({ model: '', messages: [{ role: 'user', content: prompt }] })).message.content } : {}),
  })
  return stores
}
