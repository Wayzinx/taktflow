import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { afterEach, expect, it } from 'vitest'
import { initProject } from '@taktflow/core'
import { registerEvalRoutes } from './eval-routes.js'
import { createRouter } from './router.js'
import { fail, json } from './http.js'
import type { Handler } from './routes.js'
const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
it('注册评测与样本路由，缺陷录入后重新读取；非法路径和参数返回400', async () => {
  const root = await mkdtemp(join(tmpdir(), 'takt-eval-http-')); cleanups.push(() => rm(root, { recursive: true, force: true }))
  const stores = await initProject(root)
  await stores.workspaces.createRequirement({ id: 'REQ-001', title: 'HTTP' })
  const router = createRouter<Handler>(), registered: string[] = []
  registerEvalRoutes((method, path, handler) => { registered.push(`${method} ${path}`); router.add(method, path, handler) }, async () => ({ stores, profiles: {}, harnesses: {}, knowledge: [] }))
  expect(registered).toEqual(expect.arrayContaining(['POST /api/eval/samples', 'POST /api/eval/samples/:caseId/retire', 'POST /api/eval/runs']))
  const server = createServer((request, response) => {
    const url = new URL(request.url!, 'http://localhost'), route = router.match(request.method!, url.pathname)
    if (!route) { response.writeHead(404).end(); return }
    Promise.resolve(route.handler({ stores, request, response, url, params: route.params })).then((value) => json(response, value), (error) => fail(response, error))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  cleanups.push(() => new Promise<void>((resolve, reject) => { server.close((error) => error ? reject(error) : resolve()); server.closeAllConnections() }))
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  const created = await fetch(`${base}/api/requirements/REQ-001/defects`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-takt-user': 'reviewer' }, body: JSON.stringify({ reason: '回归录入', title: '缺陷', description: 'AC-2 未覆盖', severity: 'major', acs: ['AC-2'] }) })
  expect(created.status).toBe(200)
  expect(await created.json()).toMatchObject({ id: 'D-1', status: 'open', reportedBy: { type: 'human', id: 'reviewer' } })
  expect(await (await fetch(`${base}/api/requirements/REQ-001/defects`)).json()).toMatchObject([{ id: 'D-1', title: '缺陷' }])
  expect((await fetch(`${base}/api/eval/scorecards?by=bad`)).status).toBe(400)
  expect((await fetch(`${base}/api/eval/cases?target=bad`)).status).toBe(400)
  expect((await fetch(`${base}/api/eval/runs/missing`)).status).toBe(404)
  expect((await fetch(`${base}/api/requirements/REQ-001/defects/D-1/confirm`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status).toBe(400)
})
