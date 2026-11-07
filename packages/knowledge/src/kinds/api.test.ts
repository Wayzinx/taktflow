import { afterEach, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openProject, type KnowledgeBase, type KnowledgeKindContext } from '@taktflow/core'
import { apiKind } from './api.js'
const roots: string[] = [], servers: Server[] = []
afterEach(async () => { for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())) } for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
it('OpenAPI 检索、允许的 GET、认证脱敏、非 GET 和未勾选操作被拦截、网络策略', async () => {
  const requests: string[] = [], server = createServer((req, res) => {
    requests.push(req.url!)
    res.setHeader('content-type', 'application/json')
    if (req.url === '/openapi.json') res.end(JSON.stringify({ openapi: '3.0.3', paths: { '/status': { get: { operationId: 'status', summary: '订单状态', description: '查询订单实时状态' } }, '/private': { get: { operationId: 'private' } } } }))
    else res.end(JSON.stringify({ status: 'ready', authorization: req.headers.authorization }))
  }); servers.push(server)
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  const root = await mkdtemp(join(tmpdir(), 'takt-api-')); roots.push(root)
  await writeFile(join(root, 'takt.config.json'), JSON.stringify({ project: { name: 'test' }, workflows: [] }))
  const stores = await openProject(root), context: KnowledgeKindContext = { stores, baseDir: root, indexDir: join(root, 'v1'), secrets: { resolve: async () => 'fixture-secret', set: async () => {}, list: async () => [] } }
  const base: KnowledgeBase = { id: 'api', name: 'api', kind: 'api', config: { openapi: `${url}/openapi.json`, baseURL: url, allow: ['status'], headers: { Authorization: 'secret:auth' } }, description: '', intents: ['fact'], scope: 'space', version: 0, status: 'draft', retrieval: { topK: 8, budgetTokens: 4000 }, createdAt: '', updatedAt: '', createdBy: { type: 'human', id: 'test' } }
  expect((await apiKind.build!(base, context, () => {})).stats.operations).toBe(2)
  expect((await apiKind.query(base, { text: '订单状态' }, context, base.retrieval))[0]?.ref).toBe('status')
  const hit = (await apiKind.query(base, { text: 'GET /status' }, context, base.retrieval))[0]!
  expect(hit).toMatchObject({ evidenceLevel: 'verified', snippet: expect.stringContaining('ready') })
  expect(hit.snippet).not.toContain('fixture-secret')
  for (const text of ['POST /status', 'DELETE /status', 'GET /private', 'GET //elsewhere/status', 'GET /status/../private']) await expect(apiKind.query(base, { text }, context, base.retrieval)).rejects.toThrow('允许')
  expect(requests).toEqual(['/openapi.json', '/status'])
  stores.config.sandbox = { provider: 'local', network: 'none' }
  await expect(apiKind.query(base, { text: 'GET /status' }, context, base.retrieval)).rejects.toThrow('网络')
})
