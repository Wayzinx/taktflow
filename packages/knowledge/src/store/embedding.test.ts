import { expect, it } from 'vitest'
import { createServer } from 'node:http'
import type { ProjectStores } from '@taktflow/core'
import { configuredEmbedding } from './embedding.js'
it('从模型配置调用 embeddings，按 index 排序并校验维度', async () => {
  let payload: unknown, received = ''
  const server = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk)
    payload = JSON.parse(Buffer.concat(chunks).toString()); received = req.headers.authorization ?? ''
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ data: [{ index: 1, embedding: [0, 1] }, { index: 0, embedding: [1, 0] }] }))
  })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  process.env.TAKT_EMBED_TEST_KEY = 'fixture'
  try {
    const stores = { config: { knowledgeDefaults: { embeddingModel: 'embed' }, models: { embed: { kind: 'embedding', id: 'embedding-model', provider: 'local', dimensions: 2 } }, providers: { local: { protocol: 'openai-chat', baseURL: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`, apiKeyEnv: 'TAKT_EMBED_TEST_KEY' } } } } as unknown as ProjectStores
    const embed = configuredEmbedding(stores)!
    expect(await embed(['a', 'b'])).toEqual([[1, 0], [0, 1]])
    expect(payload).toEqual({ model: 'embedding-model', input: ['a', 'b'], dimensions: 2 }); expect(received).toBe('Bearer fixture')
    stores.config.sandbox = { provider: 'local', network: 'none' }
    await expect(embed(['a', 'b'])).rejects.toThrow('网络')
  } finally { delete process.env.TAKT_EMBED_TEST_KEY; server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())) }
})
