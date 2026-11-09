import { providerFor, providerProtocols, resolveSecret, StewardError, type HarnessAdapter, type StewardDeps, type StewardPrefs, type StewardRuntime, type StewardRuntimeChoice } from '@taktflow/core'
import { createHarnesses, createProvider, providerConfig, createRedactor } from '@taktflow/harness'
import { configuredChat } from './knowledge-runtime.js'
import type { StewardMcp } from './steward-mcp.js'

export function stewardRuntime(deps: StewardDeps, userId: string, mcp: StewardMcp, url: () => string,
  harnesses = createHarnesses): Pick<StewardDeps, 'runtimeChoices' | 'resolveRuntime'> {
  const catalog = async (prefs: StewardPrefs) => {
    const spaces = (await deps.spaces()).filter(space => !space.archived)
    const preferred = spaces.find(space => space.id === prefs.defaultSpace) ?? spaces[0]
    const stores = preferred ? (await deps.open(preferred.id)).stores : undefined
    const config = stores?.config
    const adapters = harnesses({ config, projectDir: stores?.projectDir })
    const selection = prefs.harness ?? config?.steward?.harness ?? { harness: 'native' }
    const choices: StewardRuntimeChoice[] = []
    const providers = new Map<string, ReturnType<typeof providerFor>>()
    for (const [id, adapter] of Object.entries(adapters)) {
      if (id !== 'native' && (!['claude-code', 'codex'].includes(id) || !adapter.capabilities?.mcp)) continue
      const availability = id === 'native' ? { ok: true } : await adapter.available().catch(() => ({ ok: false }))
      // 外部 harness 总能用自己的登录跑（自带模型）；能换 provider 的再列出空间里配的每个模型
      const own = [[undefined, undefined] as const]
      const models = id === 'native' ? Object.entries(config?.models ?? {}) : adapter.capabilities?.customProvider ? [...own, ...Object.entries(config?.models ?? {})] : own
      for (const [alias, model] of models) {
        const raw = model && config?.providers?.[model.provider]
        const configured = raw && providerConfig(model!.provider, raw)
        const provider = configured && providerFor(configured, adapter.capabilities?.providerProtocols)
        let reason: string | undefined
        if (!availability.ok) reason = `${adapter.displayName} 未安装或不可用，请安装后重新选择`
        else if (model && !configured) reason = '模型的 provider 未配置，请在空间设置中补全'
        else if (model?.kind === 'embedding') reason = '嵌入模型不能用于对话，请选择对话模型'
        else if (configured && !provider) reason = `协议不匹配：${providerProtocols(configured).join(' / ')}，请换一个模型或 harness`
        else if (provider?.apiKeyEnv && !resolveSecret(provider.apiKeyEnv)) reason = `缺少密钥环境变量 ${provider.apiKeyEnv}，请在模型设置中配置`
        else if (provider && !provider.baseURL) reason = '模型地址未配置，请在空间设置中补全'
        const choice: StewardRuntimeChoice = { harness: id, harnessLabel: id === 'native' ? '内置（直连模型 API）' : adapter.displayName,
          model: alias, modelLabel: model?.id ?? `${adapter.displayName} 自带模型`, provider: model?.provider,
          spaceId: preferred?.id, available: !reason, reason,
          isDefault: id === (selection.harness ?? 'native') && alias === selection.model }
        choices.push(choice)
        providers.set(JSON.stringify([id, alias]), provider)
      }
    }
    return { stores, adapters, selection, choices, providers }
  }
  const pick = (choices: StewardRuntimeChoice[], runtime: StewardRuntime) => {
    const choice = choices.find(choice => choice.harness === (runtime.harness ?? 'native') && choice.model === runtime.model)
    if (!choice) throw new StewardError(400, '这个 harness 与模型组合不存在，请重新选择')
    if (!choice.available) throw new StewardError(400, choice.reason!)
    return choice
  }
  return {
    runtimeChoices: async prefs => (await catalog(prefs)).choices,
    resolveRuntime: async (prefs, runtime) => {
      const { stores, adapters, selection, choices, providers } = await catalog(prefs)
      const selected = runtime ?? selection
      if (!runtime && (selected.harness ?? 'native') === 'native' && !selected.model) return {}
      const choice = pick(choices, selected)
      const provider = providers.get(JSON.stringify([choice.harness, choice.model]))
      const model = choice.model ? stores!.config.models![choice.model]! : undefined
      if (choice.harness === 'native') {
        // 仍使用 configuredChat；有多协议入口时传入本次匹配的入口。
        const nativeStores = { ...stores!, config: { ...stores!.config, providers: { ...stores!.config.providers, [model!.provider]: provider! } } }
        const chat = provider!.protocol === 'openai-chat' ? configuredChat(nativeStores, choice.model).chat : async (request: Parameters<NonNullable<StewardDeps['chat']>>[0], onToken?: (text: string) => void) => {
          const result = await createProvider(model!.provider, provider!).chat({ ...request, model: model!.id })
          if (result.message.content) onToken?.(result.message.content)
          return result
        }
        if (!chat) throw new StewardError(400, '模型无法用于管家对话，请检查模型设置')
        return { chat, model: choice.model }
      }
      const adapter: HarnessAdapter = adapters[choice.harness]!
      return { run: async turn => {
        const grant = mcp.issue({ userId, threadId: turn.threadId, specs: turn.specs, call: turn.call })
        try {
          const history = turn.messages.filter(message => message.role !== 'system').slice(-40)
            .map(message => `${message.role}: ${message.content}`).join('\n\n').slice(-100000)
          const result = await adapter.run({ prompt: history, systemAppend: turn.messages.filter(message => message.role === 'system').map(message => message.content).join('\n\n'),
            cwd: stores!.projectDir, model: model?.id, provider: provider && model ? { ...provider, id: model.provider } : undefined,
            readOnly: true, timeoutMs: 300000,
            mcpServers: [{ name: 'takt', url: url(), headers: { Authorization: `Bearer ${grant.token}` } }],
          }, turn.onEvent)
          if (!result.ok) throw new Error(result.error ?? '未完成回复')
          return result.finalText
        } catch (error) {
          const reason = createRedactor([grant.token])(error instanceof Error ? error.message : String(error))
          throw new StewardError(502, `${adapter.displayName} 回复失败：${reason}；请检查配置后重试`)
        } finally { grant.revoke() }
      } }
    },
  }
}
