import type { KnowledgeKindContext, ProjectStores } from '@taktflow/core'
export function configuredEmbedding(stores: ProjectStores): KnowledgeKindContext['embed'] {
  const alias = stores.config.knowledgeDefaults?.embeddingModel
  if (!alias) return undefined
  return async texts => {
    const model = stores.config.models?.[alias], provider = model && stores.config.providers?.[model.provider]
    if (!model || model.kind !== 'embedding' || !provider) throw new Error('嵌入模型配置不完整，请检查 embeddingModel、模型类型和 provider')
    if (!provider.baseURL) throw new Error('嵌入接口缺少 baseURL，请填写兼容 OpenAI 的接口地址')
    if (stores.config.sandbox?.network === 'none') throw new Error('空间禁止网络访问，无法调用嵌入模型，请检查网络策略')
    const url = new URL(`${provider.baseURL.replace(/\/$/, '')}/embeddings`)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('嵌入接口地址不合法，请使用不含密钥的 HTTP(S) 地址')
    const key = provider.apiKeyEnv ? process.env[provider.apiKeyEnv] : undefined
    if (provider.apiKeyEnv && !key) throw new Error('嵌入接口密钥未配置，请设置模型要求的环境变量')
    const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...provider.headers, ...(key ? { authorization: `Bearer ${key}` } : {}) }, body: JSON.stringify({ model: model.id, input: texts, ...(model.dimensions ? { dimensions: model.dimensions } : {}) }), redirect: 'error', signal: AbortSignal.timeout(30000) })
    if (!response.ok) throw new Error(`嵌入接口失败（HTTP ${response.status}），请检查模型配置后重试`)
    const body = await response.json() as { data?: Array<{ index: number; embedding: number[] }> }
    const data = body.data?.slice().sort((a, b) => a.index - b.index)
    if (!data || data.length !== texts.length || data.some((row, i) => row.index !== i || !Array.isArray(row.embedding) || !row.embedding.length || row.embedding.some(n => !Number.isFinite(n)) || (model.dimensions && row.embedding.length !== model.dimensions))) throw new Error('嵌入接口返回格式或维度不正确，请检查模型兼容性')
    return data.map(d => d.embedding)
  }
}
