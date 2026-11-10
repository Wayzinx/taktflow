import { harnessAvailability } from './harness-availability.js'
import { providerRequest, listProviderModels } from './provider-request.js'
import { testPairing } from './pairing-test.js'
import { type ProviderBridge, type HarnessAdapter, type RuntimeTestRequest, type RuntimeTestResult, type TaktConfig } from '@taktflow/core'
import { providerConfig, collectSecrets, createRedactor } from '@taktflow/harness'
import { HttpError } from './http.js'

export async function testRuntime(config: TaktConfig, request: RuntimeTestRequest,
  harnesses: () => Promise<Record<string, HarnessAdapter>>, bridge?: ProviderBridge, fetcher: typeof fetch = fetch, projectDir?: string): Promise<RuntimeTestResult> {
  if (!request.target || !['provider', 'model', 'harness', 'pairing'].includes(request.target.kind)) throw new HttpError(400, 'target.kind 必须是 provider、model、harness 或 pairing')
  const target = request.target
  if (target.kind === 'pairing') return testPairing(config, request, harnesses, bridge)
  const id = target.kind === 'model' ? target.alias : target.id
  if (typeof id !== 'string' || !id.trim()) throw new HttpError(400, '请填写 target 的 id 或 alias')
  if (target.kind === 'model' && request.allowBilled !== true) throw new HttpError(400, '模型测试会发起一次最小计费请求；请显式设置 allowBilled: true')
  const began = Date.now()
  let billed = false
  const redact = createRedactor(collectSecrets(undefined, config.providers))
  const result = (ok: boolean, message: string, detail?: string): RuntimeTestResult => ({ ok, message: redact(message), ...(detail ? { detail: redact(detail) } : {}), billed, latencyMs: Date.now() - began })
  if (target.kind === 'harness') {
    if (config.harnessOverrides?.[id]?.disabled) return result(false, '本空间已停用')
    const harness = (await harnesses())[id]
    if (!harness) throw new HttpError(400, 'harness 不存在；请先登记 harness')
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const probe = await Promise.race([harnessAvailability(config, projectDir, harness, true), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('探测超过 10 秒；请检查启动命令')), 10_000) })])
      return result(probe.ok, probe.ok ? 'Harness 可用' : probe.reason ?? 'Harness 不可用；请检查启动命令', probe.detail)
    } catch { return result(false, 'Harness 探测失败或超时；请检查启动命令和安装状态') }
    finally { clearTimeout(timer) }
  }
  const model = target.kind === 'model' ? config.models?.[id] : undefined
  if (target.kind === 'model' && !model) throw new HttpError(400, '模型别名不存在；请先登记模型')
  const providerId = model?.provider ?? id
  const raw = config.providers?.[providerId]
  if (!raw) throw new HttpError(400, 'provider 不存在；请先登记 provider')
  const provider = providerConfig(providerId, raw)
  try {
    if (target.kind === 'provider') {
      const models = await listProviderModels(provider, fetcher)
      return result(true, 'Provider 连通正常', `返回 ${models.length} 个模型`)
    }
    const { url, headers } = providerRequest(provider)
    const base = url.pathname.replace(/\/+$/, '')
    let payload: unknown
    if (model!.kind === 'embedding') {
      if (provider.protocol !== 'openai-chat') return result(false, '此协议尚不支持向量测试；请使用 openai-chat 兼容接口')
      url.pathname = `${base}/embeddings`
      payload = { model: model!.id, input: 'a' }
    } else if (provider.protocol === 'openai-chat' || provider.protocol === 'anthropic-messages') {
      url.pathname = `${base}/${provider.protocol === 'openai-chat' ? 'chat/completions' : 'messages'}`
      payload = { model: model!.id, messages: [{ role: 'user', content: 'Hi' }], max_tokens: 1 }
    } else if (provider.protocol === 'openai-responses') {
      url.pathname = `${base}/responses`
      payload = { model: model!.id, input: 'Hi', max_output_tokens: 1 }
    } else if (provider.protocol === 'gemini') {
      url.pathname = `${base}/models/${encodeURIComponent(model!.id.replace(/^models\//, ''))}:generateContent`
      payload = { contents: [{ parts: [{ text: 'Hi' }] }], generationConfig: { maxOutputTokens: 1 } }
    } else return result(false, '此协议尚不支持连通测试；请使用对应厂商工具验证')
    // 仅发送一次，不重试、不跟随跳转；请求发出后即标为可能计费，失败也不宣称免费。
    billed = target.kind === 'model'
    const response = await fetcher(url, { method: billed ? 'POST' : 'GET', headers,
      ...(payload ? { body: JSON.stringify(payload) } : {}), signal: AbortSignal.timeout(10_000), redirect: 'manual' })
    if (!response.ok) { await response.body?.cancel(); return result(false, `服务返回 HTTP ${response.status}；请检查地址、密钥和模型权限`) }
    const value = await response.json() as Record<string, unknown>
    const valid = model!.kind === 'embedding' ? Array.isArray(value.data) && value.data.length > 0
      : provider.protocol === 'openai-chat' ? Array.isArray(value.choices) && value.choices.length > 0
      : provider.protocol === 'anthropic-messages' ? Array.isArray(value.content)
      : provider.protocol === 'openai-responses' ? Array.isArray(value.output) : Array.isArray(value.candidates)
    return result(valid, valid ? '模型最小请求成功' : '模型响应格式不正确；请核对协议')
  } catch (error) { return result(false, error instanceof Error ? error.message : '连通测试失败；请检查服务地址、密钥和网络') }
}
