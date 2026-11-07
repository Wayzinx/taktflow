import { afterEach, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { initProject, readJsonLines } from '@taktflow/core'
import { createKnowledgeStore } from '../../knowledge/src/store/index.js'
import { createSecretResolver } from '../../knowledge/src/store/secrets.js'
import { registerKnowledgeRoutes } from './knowledge-routes.js'
import { createRouter } from './router.js'
import { fail, json } from './http.js'
import { STREAMING, type Handler } from './routes.js'
const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
it('HTTP 创建→上传→构建 SSE→检索→发布→详情回读，以及权限与路径防护', async () => {
  const root = await mkdtemp(join(tmpdir(), 'takt-kb-http-')); cleanups.push(() => rm(root, { recursive: true, force: true }))
  const stores = await initProject(root), secrets = createSecretResolver(join(root, '.secrets.json'))
  stores.config.members = [{ id: 'owner', name: 'owner', role: 'owner' }, { id: 'viewer', name: 'viewer', role: 'viewer' }]
  stores.kb = createKnowledgeStore(stores, { secrets })
  const router = createRouter<Handler>(), connections = new Set<() => void>()
  registerKnowledgeRoutes(router, { secrets, connections })
  const server = createServer((request, response) => {
    const url = new URL(request.url!, 'http://localhost'), route = router.match(request.method!, url.pathname)
    if (!route) { response.writeHead(404).end(); return }
    Promise.resolve(route.handler({ stores, request, response, url, params: route.params })).then(value => { if (value !== STREAMING) json(response, value) }, error => fail(response, error))
  })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  cleanups.push(() => new Promise<void>(r => { for (const close of connections) close(); server.closeAllConnections(); server.close(() => r()) }))
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/knowledge`
  const request = (path: string, method = 'GET', input?: unknown, user = 'owner') => fetch(`${base}${path}`, { method, headers: { 'content-type': 'application/json', 'x-takt-user': user }, ...(input === undefined ? {} : { body: JSON.stringify(input) }) })
  expect((await request('/kinds').then(r => r.json())).map((k: { kind: string }) => k.kind)).toEqual(['rag', 'llm-wiki', 'database', 'api', 'code', 'history'])
  expect((await request('/bases', 'POST', { name: '文档', kind: 'rag', config: {} })).status).toBe(400)
  expect(await request('/bases', 'POST', { id: 'docs', name: '文档', kind: 'rag', config: {}, reason: '建立规则库' }).then(r => r.json())).toMatchObject({ id: 'docs', bound: true })
  // 配置写入会刷新 stores.config，恢复夹具的角色表以验证拒绝分支。
  stores.config.members = [{ id: 'owner', name: 'owner', role: 'owner' }, { id: 'viewer', name: 'viewer', role: 'viewer' }]
  expect((await request('/bases/docs/upload', 'POST', { files: [{ path: 'a.md', content: '# 退款\n七天退款' }] }, 'viewer')).status).toBe(403)
  expect((await request('/bases/docs/upload', 'POST', { files: [{ path: '../escape.md', content: 'x' }] })).status).toBe(400)
  expect(await request('/bases/docs/upload', 'POST', { files: [{ path: 'a.md', content: '# 退款\n七天退款' }] }).then(r => r.json())).toEqual({ docs: 1 })
  const build = await request('/bases/docs/builds', 'POST', { reason: '构建' }).then(r => r.json())
  const events = await request(`/bases/docs/builds/${build.id}/stream`).then(r => r.text())
  expect(events).toContain('"status":"succeeded"')
  expect(await request('/bases/docs/query', 'POST', { text: '退款' }).then(r => r.json())).toMatchObject({ hits: [{ ref: 'a.md#0', content: expect.stringContaining('七天') }] })
  expect(await readJsonLines(join(stores.taktDir, 'knowledge/queries.jsonl'))).toMatchObject([{ via: 'playground' }])
  expect(await request('/bases/docs/publish', 'POST', { reason: '批准' }).then(r => r.json())).toMatchObject({ base: { version: 1, status: 'ready' }, gate: { pass: true } })
  expect(await request('/bases/docs').then(r => r.json())).toMatchObject({ id: 'docs', usage: { trend: expect.any(Array) }, builds: [{ status: 'succeeded' }] })
  await request('/bases/docs/evals/manual/cases', 'PUT', { cases: [{ query: '退款', relevant: [{ ref: 'a.md#0', grade: 3 }], source: 'manual', status: 'active', createdBy: { type: 'human', id: 'owner' } }] })
  const evaluation = await request('/bases/docs/eval-runs', 'POST', { setId: 'manual', variants: [{ id: 'baseline', label: '基线', version: 1 }] }).then(r => r.json())
  for (let i = 0; i < 100; i++) {
    const result = await request(`/bases/docs/eval-runs/${evaluation.id}`).then(r => r.json())
    if (result.status !== 'running') { expect(result.status).toBe('done'); break }
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  expect(await request('/bases/docs').then(r => r.json())).toMatchObject({ usage7d: { queries: 1 } })
  expect((await readJsonLines<{ via: string }>(join(stores.taktDir, 'knowledge/queries.jsonl'))).map(q => q.via)).toEqual(['playground', 'eval'])
  expect(await request('/secrets/auth', 'PUT', { value: 'do-not-display', reason: '配置认证' }).then(r => r.json())).toEqual({ name: 'auth' })
  expect(await request('/secrets/auth', 'PUT', { value: 'do-not-display' }).then(r => r.json())).toEqual({ name: 'auth' })
  expect(await request('/secrets').then(r => r.json())).toEqual(['auth'])
  expect((await request('/secrets', 'GET', undefined, 'viewer')).status).toBe(403)
  expect((await request('/bases/%2e%2e%2fescape')).status).toBe(400)
  expect((await request('/bases/docs', 'DELETE', { reason: '删除测试数据' })).status).toBe(204)
  expect((await request('/bases/docs')).status).toBe(404)
})
