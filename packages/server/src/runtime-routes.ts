import { assertSecretName, patchRuntimeConfig, providerProtocols, readRuntimeConfig, RuntimeConfigError, setLocalSecret, systemWrite, validateHarnessSelector,
  type ProviderBridge, type ProjectStores, type RuntimeConfig, type RuntimeTestRequest, type TaktConfig } from '@taktflow/core'
import { ACP_PRESETS, PROVIDER_PRESETS, createHarnesses, providerConfig, collectSecrets, createRedactor, withProviderPresets } from '@taktflow/harness'
import { actor, authorize, body, HttpError, text } from './http.js'
import type { Handler } from './routes.js'
import type { M3Callbacks } from './m3-routes.js'
import { testRuntime } from './runtime-test.js'
import { auditSpace } from './space.js'

export interface RuntimeCallbacks {
  bridge?: ProviderBridge
  prepareRuntime?(stores: ProjectStores, config: TaktConfig): Promise<() => void>
}
const brands: Record<string, string> = { openai: 'OpenAI', anthropic: 'Anthropic', deepseek: 'DeepSeek', moonshot: 'Moonshot', zhipu: '智谱', dashscope: '阿里百炼', ark: '火山方舟', minimax: 'MiniMax 国际', 'minimax-cn': 'MiniMax 国内', 'ark-coding': '方舟 Coding Plan', siliconflow: '硅基流动', openrouter: 'OpenRouter', 'azure-openai': 'Azure OpenAI', ollama: 'Ollama', vllm: 'vLLM', lmstudio: 'LM Studio', litellm: 'LiteLLM' }
const presets: RuntimeConfig['presets'] = {
  providers: Object.entries(PROVIDER_PRESETS).map(([id, config]) => ({ id, displayName: brands[id]!, protocol: config.protocol, baseURL: config.baseURL, ...('apiKeyEnv' in config ? { apiKeyEnv: config.apiKeyEnv } : {}), ...('endpoints' in config ? { endpoints: config.endpoints } : {}) })),
  acp: ACP_PRESETS,
}

function view(config: TaktConfig): RuntimeConfig {
  const value = readRuntimeConfig(config, presets, providerConfig)
  const redact = createRedactor(collectSecrets(undefined, config.providers))
  // 旧配置允许内联 header/env；设置页只得到遮盖值，补丁回传遮盖值时沿用原值。
  for (const p of Object.values(value.providers)) if (p.headers) p.headers = Object.fromEntries(Object.keys(p.headers).map(k => [k, '[REDACTED]']))
  for (const h of [...value.harnesses, ...Object.values(value.harnessOverrides)]) if (h.env) h.env = Object.fromEntries(Object.keys(h.env).map(k => [k, '[REDACTED]']))
  const safe = JSON.parse(redact(JSON.stringify(value))) as RuntimeConfig
  safe.revision = value.revision
  return safe
}

export function runtimeRoutes(add: (method: string, path: string, handler: Handler) => void, options: RuntimeCallbacks & M3Callbacks) {
  add('GET', '/api/space/runtime', ({ stores }) => view(stores.config))
  add('PATCH', '/api/space/runtime', async ({ stores, request }) => {
    authorize(request, stores, 'owner')
    const input = await body(request)
    const runtime = await options.resolveRuntime?.(stores)
    const builtinHarnesses = Object.keys(createHarnesses())
    try {
      await patchRuntimeConfig(stores, input, actor(request, stores), {
        builtinHarnesses,
        pluginHarnesses: Object.keys(runtime?.harnesses ?? {}).filter(id => !builtinHarnesses.includes(id) && !stores.config.harnesses?.some(h => h.id === id)),
        protocols: Object.values(stores.config.providers ?? {}).flatMap(providerProtocols).filter(protocol => Object.values(runtime?.harnesses ?? {}).some(h => h.capabilities?.providerProtocols?.includes(protocol))),
        acpPresets: ACP_PRESETS.map(p => p.id), providerPresets: Object.keys(PROVIDER_PRESETS),
        prepare: async config => {
          if (options.prepareRuntime) return options.prepareRuntime(stores, config)
          const normalized = withProviderPresets(config)
          const harnesses = createHarnesses({ config: normalized, projectDir: stores.projectDir })
          for (const [id, harness] of Object.entries(runtime?.harnesses ?? {})) {
            if (!builtinHarnesses.includes(id) && !stores.config.harnesses?.some(h => h.id === id)) harnesses[id] = harness
          }
          try {
            for (const selector of [...Object.values(config.roles ?? {}), ...Object.values(readRuntimeConfig(config, presets).system)]) validateHarnessSelector(selector, normalized, harnesses, options.bridge)
          } catch { throw new RuntimeConfigError(400, 'roles/system：harness 与模型或 provider 协议不兼容；请检查选择的能力后重试') }
          return () => {}
        },
      })
      return view(stores.config)
    } catch (error) {
      if (error instanceof RuntimeConfigError) throw new HttpError(error.status, createRedactor(collectSecrets(undefined, stores.config.providers))(error.message))
      throw error
    }
  })
  add('POST', '/api/space/runtime/test', async ({ stores, request }) => {
    authorize(request, stores, 'owner')
    const input = await body(request)
    return testRuntime(stores.config, input as unknown as RuntimeTestRequest,
      async () => (await options.resolveRuntime?.(stores))?.harnesses ?? createHarnesses({ config: stores.config, projectDir: stores.projectDir }), options.bridge)
  })
  for (const method of ['PUT', 'DELETE']) add(method, '/api/secrets/:name', async ({ stores, request, params }) => {
    authorize(request, stores, 'owner')
    try { assertSecretName(params.name!) } catch (error) { throw new HttpError(400, (error as Error).message) }
    const input = await body(request, true)
    const reason = text(input.reason, 'reason（修改原因）')
    const value = method === 'PUT' ? text(input.value, 'value') : null
    return systemWrite(stores.projectDir, ['.takt/space-events.jsonl*'], async () => {
      await auditSpace(stores, actor(request, stores), reason, JSON.stringify({ name: params.name!, operation: method }))
      return setLocalSecret(params.name!, value)
    })
  })
}
