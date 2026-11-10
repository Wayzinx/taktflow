import { resolveSecret, type ProviderConfig } from '@taktflow/core'
import { modelDeadline } from './model-cache.js'

export function providerRequest(provider: ProviderConfig): { url: URL; headers: Headers } {
  if (!provider.baseURL) throw new Error('未配置 baseURL')
  const url = new URL(provider.baseURL)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('服务地址不合法；请使用无凭据的 HTTP(S) 地址')
  const headers = new Headers({ 'content-type': 'application/json', ...provider.headers })
  const key = provider.apiKeyEnv ? resolveSecret(provider.apiKeyEnv) : undefined
  if (provider.apiKeyEnv && !key) throw new Error(`缺少密钥 ${provider.apiKeyEnv}`)
  if (provider.protocol === 'anthropic-messages') headers.set('anthropic-version', '2023-06-01')
  if (key) {
    const header = provider.preset === 'azure-openai' ? 'api-key' : provider.protocol === 'anthropic-messages' ? 'x-api-key' : provider.protocol === 'gemini' ? 'x-goog-api-key' : 'authorization'
    headers.set(header, header === 'authorization' ? `Bearer ${key}` : key)
  }
  let path = url.pathname.replace(/\/+$/, '').replace(/\/(chat\/completions|responses|messages|embeddings)$/, '')
  if (provider.protocol === 'anthropic-messages' && !path.endsWith('/v1')) path += '/v1'
  if (provider.protocol === 'gemini' && !path.endsWith('/v1beta')) path = path.replace(/\/v1$/, '') + '/v1beta'
  url.pathname = path
  return { url, headers }
}

export async function listProviderModels(provider: ProviderConfig, fetcher: typeof fetch = fetch): Promise<unknown[]> {
  if (!['openai-chat', 'openai-responses', 'anthropic-messages', 'gemini'].includes(provider.protocol)) throw new Error('此协议不支持模型列表')
  const { url, headers } = providerRequest(provider)
  url.pathname = url.pathname.replace(/\/+$/, '') + '/models'
  return modelDeadline(async signal => {
    const rows: unknown[] = []
    const cursors = new Set<string>()
    for (let page = 0; page < 10; page++) {
      const response = await fetcher(url.toString(), { headers, signal, redirect: 'manual' })
      if (!response.ok) { await response.body?.cancel(); throw new Error(`列模型失败（HTTP ${response.status}）`) }
      const value: unknown = await response.json()
      if (!value || typeof value !== 'object') throw new Error('列模型响应格式不正确')
      const data = value as Record<string, unknown>
      const models = provider.protocol === 'gemini' ? data.models : data.data
      if (!Array.isArray(models)) throw new Error('列模型响应格式不正确')
      rows.push(...models)
      const cursor = provider.protocol === 'anthropic-messages' && data.has_more === true ? data.last_id
        : provider.protocol === 'gemini' ? data.nextPageToken : undefined
      if (provider.protocol === 'anthropic-messages' && data.has_more === true && (typeof cursor !== 'string' || !cursor)) throw new Error('模型列表分页游标缺失')
      if (cursor === undefined || cursor === '') return rows
      if (typeof cursor !== 'string' || cursors.has(cursor)) throw new Error('模型列表分页游标不正确')
      cursors.add(cursor)
      url.searchParams.set(provider.protocol === 'gemini' ? 'pageToken' : 'after_id', cursor)
    }
    // 不完整的列表不能用来判断模型下架。
    throw new Error('模型列表超过 10 页，未获取完整列表')
  }, 10_000)
}
