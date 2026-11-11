import { harnessAvailability } from './harness-availability.js'
import { providerFor, providerProtocols, resolvePairing, resolveHarnessSelector, resolveSecret, StewardError, type BridgeRoute, type HarnessAdapter, type ProviderBridge, type StewardDeps, type StewardPrefs, type StewardRuntimeChoice } from '@taktflow/core'
import { createHarnesses, createProvider, providerConfig, createRedactor } from '@taktflow/harness'
import type { StewardMcp } from './steward-mcp.js'

export function stewardRuntime(deps: StewardDeps, userId: string, mcp: StewardMcp, url: () => string,
  harnesses = createHarnesses, bridge?: ProviderBridge): Pick<StewardDeps, 'runtimeChoices' | 'resolveRuntime'> {
  const catalog = async (prefs: StewardPrefs) => {
    const spaces = (await deps.spaces()).filter(space => !space.archived)
    let preferred = spaces.find(space => space.id === prefs.defaultSpace)
    let stores = preferred ? (await deps.open(preferred.id)).stores : undefined
    // 没设默认空间：取第一个配了模型的空间，别让排在最前的空空间把模型都藏掉
    if (!preferred) for (const space of spaces) {
      const opened = (await deps.open(space.id)).stores
      if (!stores) { preferred = space; stores = opened }
      if (Object.keys(opened.config.models ?? {}).length) { preferred = space; stores = opened; break }
    }
    const config = stores?.config
    const adapters = harnesses({ config, projectDir: stores?.projectDir })
    const selection = prefs.harness ?? config?.steward?.harness ?? { harness: 'native' }
    const choices: StewardRuntimeChoice[] = []
    for (const [id, adapter] of Object.entries(adapters)) {
      // 管家靠 MCP 调 takt 的工具：外部 harness 只列能接 MCP 的
      if (id !== 'native' && !adapter.capabilities?.mcp) continue
      const availability: Awaited<ReturnType<HarnessAdapter['available']>> = id === 'native' ? { ok: true } : await harnessAvailability(config, stores?.projectDir, adapter)
      // 外部 harness 总能用自己的登录跑（自带模型）；能换 provider 的再列出空间里配的每个模型
      const own = [[undefined, undefined] as const]
      const models = id === 'native' ? Object.entries(config?.models ?? {}) : adapter.capabilities?.customProvider ? [...own, ...Object.entries(config?.models ?? {})] : own
      for (const [alias, model] of models) {
        const raw = model && config?.providers?.[model.provider]
        const configured = raw ? providerConfig(model!.provider, raw) : undefined
        // 内置直接调模型 API，只认 provider 提供的入口；外部 harness 协议对不上时经协议桥（和节点调用同一套判断）
        const resolved = id === 'native' ? { target: configured && providerFor(configured, adapter.capabilities?.providerProtocols) } : resolvePairing(adapter.capabilities ?? {}, configured, bridge)
        const provider = resolved.target
        let reason: string | undefined
        if (!availability.ok) reason = `${adapter.displayName} 未安装或不可用，请安装后重新选择`
        else if (!model && availability.ownReady === false) reason = availability.ownReason ?? '自带账号未就绪'
        else if (model && !configured) reason = '模型的 provider 未配置，请在空间设置中补全'
        else if (model?.kind === 'embedding') reason = '嵌入模型不能用于对话，请选择对话模型'
        else if (configured && !provider) reason = `协议不匹配：${providerProtocols(configured).join(' / ')}，请换一个模型或 harness`
        else if ('reason' in resolved && resolved.reason) reason = resolved.reason
        else if (provider?.apiKeyEnv && !resolveSecret(provider.apiKeyEnv)) reason = `缺少密钥环境变量 ${provider.apiKeyEnv}，请在模型设置中配置`
        else if (provider && !provider.baseURL) reason = '模型地址未配置，请在空间设置中补全'
        const pairing = 'pairing' in resolved ? resolved.pairing : undefined
        const choice: StewardRuntimeChoice = { harness: id, harnessLabel: id === 'native' ? '内置（直连模型 API）' : adapter.displayName,
          model: alias, modelLabel: model?.id ?? `${adapter.displayName} 自带模型`, provider: model?.provider,
          spaceId: preferred?.id, available: !reason, reason,
          isDefault: id === (selection.harness ?? 'native') && alias === selection.model && (!selection.provider || selection.provider === model?.provider), ...(pairing ? { pairing } : {}) }
        choices.push(choice)
      }
    }
    return { stores, adapters, selection, choices }
  }
  return {
    runtimeChoices: async prefs => (await catalog(prefs)).choices,
    resolveRuntime: async (prefs, runtime) => {
      const { stores, adapters, selection } = await catalog(prefs)
      const selected = runtime ?? selection
      if (!runtime && (selected.harness ?? 'native') === 'native' && !selected.model && !selected.provider) return {}
      if (!stores) throw new StewardError(400, '请先创建空间并配置运行时')
      const config = { ...stores.config, providers: Object.fromEntries(Object.entries(stores.config.providers ?? {}).map(([id, value]) => [id, providerConfig(id, value)])) }
      let resolved: ReturnType<typeof resolveHarnessSelector>
      try { resolved = resolveHarnessSelector({ ...selected, harness: selected.harness ?? 'native' }, config, adapters, bridge) }
      catch (error) { throw new StewardError(400, (error as Error).message) }
      const { harness: adapter, model: modelId, modelConfig, provider, pairing } = resolved
      if (adapter.id !== 'native' && !adapter.capabilities?.mcp) throw new StewardError(400, '这个 harness 不支持管家的 MCP 工具')
      const availability = adapter.id === 'native' ? { ok: true } : await harnessAvailability(config, stores.projectDir, adapter)
      if (!availability.ok) throw new StewardError(400, `${adapter.displayName} 未安装或不可用，请安装后重新选择`)
      if (!provider && 'ownReady' in availability && availability.ownReady === false) throw new StewardError(400, availability.ownReason ?? '自带账号未就绪')
      if (modelConfig?.kind === 'embedding') throw new StewardError(400, '嵌入模型不能用于对话')
      if (provider?.apiKeyEnv && !resolveSecret(provider.apiKeyEnv)) throw new StewardError(400, `缺少密钥环境变量 ${provider.apiKeyEnv}`)
      if (provider && (!provider.baseURL || !modelId?.trim())) throw new StewardError(400, '模型地址或模型未配置')
      if (adapter.id === 'native') {
        if (!provider || !modelId) throw new StewardError(400, '直连 API 需要 provider 与模型')
        const target = providerFor(provider, adapter.capabilities?.providerProtocols)
        if (!target) throw new StewardError(400, '直连 API 不支持此协议')
        const chat: NonNullable<StewardDeps['chat']> = async (request, onToken) => {
          const result = await createProvider(provider.id, target, { resolveSecret }).chat({ ...request, model: modelId })
          if (result.message.content) onToken?.(result.message.content)
          return result
        }
        return { chat, model: selected.model }
      }
      return { run: async turn => {
        const grant = mcp.issue({ userId, threadId: turn.threadId, specs: turn.specs, call: turn.call })
        let route: BridgeRoute | undefined
        try {
          const history = turn.messages.filter(message => message.role !== 'system').slice(-40)
            .map(message => `${message.role}: ${message.content}`).join('\n\n').slice(-100000)
          let connection = provider
          // 协议对不上：每轮开一条本机协议桥路由，harness 连桥、拿一次性令牌，本轮结束就关
          if (pairing?.mode === 'bridge') {
            if (!bridge) throw new Error('协议桥没有启动')
            route = await bridge.open(connection!, pairing.protocol!, { model: modelId, effort: selected.effort })
            connection = route.provider
          }
          const result = await adapter.run({ prompt: history, systemAppend: turn.messages.filter(message => message.role === 'system').map(message => message.content).join('\n\n'),
            cwd: stores.projectDir, model: modelId, modelConfig, effort: selected.effort, provider: connection, ...(route ? { env: route.env } : {}),
            readOnly: true, timeoutMs: STEWARD_TIMEOUT_MS,
            mcpServers: [{ name: 'takt', url: url(), headers: { Authorization: `Bearer ${grant.token}` } }],
          }, turn.onEvent)
          if (result.ok) return result.finalText
          // 回复已经写出来、进程却没按时退出（CLI 收尾卡住）：把写好的内容交给人，说明可能不完整，不整条判失败
          if (isTimeout(result.error) && result.finalText.trim()) return `${result.finalText}\n\n（${adapter.displayName} 在 ${STEWARD_TIMEOUT_MS / 60_000} 分钟内没有正常结束，以上是停止前写出的内容，可能不完整。）`
          throw new Error(result.error ?? '未完成回复')
        } catch (error) {
          const reason = createRedactor([grant.token, ...Object.values(route?.env ?? {})])(error instanceof Error ? error.message : String(error))
          throw new StewardError(502, failureText(adapter.displayName, reason))
        } finally { grant.revoke(); await route?.close().catch(() => undefined) }
      } }
    },
  }
}

/** 管家一轮可能连调多次工具、推理模型想得久：给 10 分钟。 */
export const STEWARD_TIMEOUT_MS = 600_000
const isTimeout = (error?: string) => !!error && /Process timeout after/.test(error)

/** CLI 报错给人看：超时就说超时和怎么办；其余去掉 CLI 的日志行、进程信号，只留第一句。 */
export function failureText(name: string, reason: string): string {
  if (isTimeout(reason)) return `${name} ${STEWARD_TIMEOUT_MS / 60_000} 分钟内没有写完回复，已停止。可以调低推理强度、换个更快的模型，或把问题问得具体一些再试`
  const lines = reason.split('\n').map((line) => line.trim()).filter(Boolean)
  const line = lines.find((l) => !/^\d{4}-\d\d-\d\dT\S+\s+(ERROR|WARN|INFO|DEBUG)\b/.test(l) && !/^Process (terminated|exited)/.test(l)) ?? lines[0] ?? reason
  return `${name} 回复失败：${line.length > 200 ? `${line.slice(0, 200)}…` : line}；请检查配置后重试`
}
