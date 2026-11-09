import { resolveSecret, type HarnessAdapter, type RuntimeTestRequest, type RuntimeTestResult, type TaktConfig } from '@taktflow/core'
import { providerConfig, collectSecrets, createRedactor } from '@taktflow/harness'
import { HttpError } from './http.js'

export async function testRuntime(config: TaktConfig, request: RuntimeTestRequest,
  harnesses: () => Promise<Record<string, HarnessAdapter>>): Promise<RuntimeTestResult> {
  if (!request.target || !['provider', 'model', 'harness'].includes(request.target.kind)) throw new HttpError(400, 'target.kind 必须是 provider、model 或 harness')
  const target = request.target
  if (target.kind === 'pairing') throw new HttpError(400, '搭配测试尚未实现')
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
      const probe = await Promise.race([harness.available(), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('探测超过 10 秒；请检查启动命令')), 10_000) })])
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
    if (!provider.baseURL) return result(false, '未配置 baseURL；请填写服务地址')
    const url = new URL(provider.baseURL)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return result(false, '服务地址不合法；请使用无凭据的 HTTP(S) 地址')
    const headers = new Headers({ 'content-type': 'application/json', ...provider.headers })
    const key = provider.apiKeyEnv ? resolveSecret(provider.apiKeyEnv) : undefined
    if (provider.apiKeyEnv && !key) return result(false, '密钥缺失；请设置环境变量或本机密钥库')
    if (provider.protocol === 'anthropic-messages') headers.set('anthropic-version', '2023-06-01')
    if (key) {
      const header = provider.preset === 'azure-openai' ? 'api-key' : provider.protocol === 'anthropic-messages' ? 'x-api-key' : provider.protocol === 'gemini' ? 'x-goog-api-key' : 'authorization'
      headers.set(header, header === 'authorization' ? `Bearer ${key}` : key)
    }
    const path = url.pathname.replace(/\/+$/, '').replace(/\/(chat\/completions|responses|messages|embeddings)$/, '')
    const base = provider.protocol === 'anthropic-messages' && !path.endsWith('/v1') ? `${path}/v1` : path
    let payload: unknown
    if (target.kind === 'provider') {
      url.pathname = `${base}/models`
    } else if (model!.kind === 'embedding') {
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
    const response = await fetch(url, { method: billed ? 'POST' : 'GET', headers,
      ...(payload ? { body: JSON.stringify(payload) } : {}), signal: AbortSignal.timeout(10_000), redirect: 'manual' })
    if (!response.ok) { await response.body?.cancel(); return result(false, `服务返回 HTTP ${response.status}；请检查地址、密钥和模型权限`) }
    const value = await response.json() as Record<string, unknown>
    if (target.kind === 'provider') {
      const models = value.data ?? value.models
      if (!Array.isArray(models)) return result(false, '列模型响应格式不正确；请检查服务地址和协议')
      return result(true, 'Provider 连通正常', `返回 ${models.length} 个模型`)
    }
    const valid = model!.kind === 'embedding' ? Array.isArray(value.data) && value.data.length > 0
      : provider.protocol === 'openai-chat' ? Array.isArray(value.choices) && value.choices.length > 0
      : provider.protocol === 'anthropic-messages' ? Array.isArray(value.content)
      : provider.protocol === 'openai-responses' ? Array.isArray(value.output) : Array.isArray(value.candidates)
    return result(valid, valid ? '模型最小请求成功' : '模型响应格式不正确；请核对协议')
  } catch { return result(false, '连通测试失败或超过 10 秒；请检查服务地址、密钥和网络') }
}
