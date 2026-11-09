import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, expect, it } from 'vitest'
import { initProject, type RunDetail, type RunState, type RunSummary } from '@taktflow/core'
import { routes, type RequestContext } from './routes.js'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

it('列表、详情路由仅在运行中且租约缺失或死亡时带 interrupted', async () => {
  const root = await mkdtemp(join(tmpdir(), 'takt-run-liveness-')); roots.push(root)
  const stores = await initProject(root)
  const req = await stores.workspaces.createRequirement({ title: '中断状态' })
  const { stdout } = await promisify(execFile)(process.execPath, ['-e', 'console.log(process.pid)'])
  const dead = Number(stdout.trim())
  const cases = [
    { id: 'missing', status: 'running', interrupted: true },
    { id: 'dead', status: 'running', owner: { pid: dead, host: hostname() }, interrupted: true },
    { id: 'live', status: 'running', owner: { pid: process.pid, host: hostname() }, interrupted: false },
    { id: 'foreign', status: 'running', owner: { pid: dead, host: `${hostname()}-other` }, interrupted: false },
    { id: 'invalid', status: 'running', owner: {}, interrupted: false },
    { id: 'finished', status: 'succeeded', interrupted: false },
  ] as const
  for (const item of cases) {
    const state: RunState = { runId: item.id, workflowId: 'flow', workflowVersion: '1', requirementId: req.id, status: item.status, startedAt: new Date().toISOString(), nodes: {}, args: {}, expansions: [] }
    await stores.runs.create(state, { id: 'flow', title: '流程', version: '1', stages: [], nodes: [] })
    if ('owner' in item) await writeFile(join(stores.taktDir, 'runs', item.id, 'lease.json'), JSON.stringify(item.owner))
  }
  // 直接调用生产路由，无监听端口、无 HTTP 请求。
  const router = routes(new Set())
  const invoke = async (pathname: string) => {
    const matched = router.match('GET', pathname)!
    return matched.handler({ stores, params: matched.params, url: new URL(pathname, 'http://test.invalid') } as RequestContext)
  }
  const summaries = await invoke('/api/runs') as RunSummary[]
  for (const item of cases) {
    const summary = summaries.find(run => run.runId === item.id)!
    const detail = await invoke(`/api/runs/${item.id}`) as RunDetail
    for (const value of [summary, detail]) {
      if (item.interrupted) expect(value).toHaveProperty('interrupted', true)
      else expect(value).not.toHaveProperty('interrupted')
    }
  }
  // 续跑活租约出现后重新读路由，不能沿用中断缓存。
  await writeFile(join(stores.taktDir, 'runs', 'missing', 'lease.json'), JSON.stringify({ pid: process.pid, host: hostname() }))
  expect(await invoke('/api/runs/missing')).not.toHaveProperty('interrupted')
  expect((await invoke('/api/runs') as RunSummary[]).find(run => run.runId === 'missing')).not.toHaveProperty('interrupted')
})
