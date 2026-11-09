import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { initProject, type HarnessRequest, type ProjectStores } from '@taktflow/core'
import { createServer } from '@taktflow/server'
import { loadRuntime } from '../project.js'
import { liveProjects } from './serve.js'

const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); vi.unstubAllEnvs() })
async function rootDir() {
  const root = await mkdtemp(join(tmpdir(), 'takt-serve-roles-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  vi.stubEnv('TAKT_SECRETS_FILE', join(root, 'private/keys.json'))
  return root
}
async function setupSpace(dir: string) {
  const stores = await initProject(dir)
  stores.config.workflows = []
  await writeFile(join(dir, 'takt.config.json'), JSON.stringify(stores.config))
  await writeFile(join(dir, 'package.json'), '{"type":"module"}')
  await writeFile(join(stores.paths.agents, 'dev.md'), '---\nharness: mock\n---\n初始角色正文')
  await writeFile(join(stores.paths.workflows, 'work.workflow.ts'), `export default { id: 'work', title: '工作', version: '1', stages: [], nodes: [{ id: 'work', title: '工作', kind: 'agent', role: 'dev', prompt: '执行工作' }] }`)
  await writeFile(join(stores.taktDir, 'mock.json'), JSON.stringify({ steps: [{ match: { role: 'dev' }, text: 'mock 完成' }] }))
  return stores
}
function callbacks(projects: ReturnType<typeof liveProjects>) {
  return {
    onSpaceLoad: async (stores: ProjectStores) => { await projects.ensure(stores.projectDir) },
    onSpaceUnload: projects.remove,
    getCommands: async (stores: ProjectStores) => (await projects.ensure(stores.projectDir)).getCommands(stores),
    resolveRuntime: async (stores: ProjectStores) => (await projects.ensure(stores.projectDir)).resolveRuntime(stores),
  }
}
function requestAt(url: string) {
  return (path: string, method = 'GET', input?: object) => fetch(url + path, { method, headers: { 'content-type': 'application/json' }, ...(input ? { body: JSON.stringify(input) } : {}) })
}
it('同一 serve 保存角色后，命令新运行与运行时缓存均读到新正文及 harness', async () => {
  const root = await rootDir(), stores = await setupSpace(join(root, 'space'))
  const initial = await loadRuntime(stores.projectDir)
  const calls: HarnessRequest[] = []
  initial.harnesses.mock!.run = vi.fn(async request => { calls.push(request); return { ok: true, finalText: '完成' } })
  initial.stores.config.roles = { dev: { harness: 'codex' } }
  await writeFile(join(stores.projectDir, 'takt.config.json'), JSON.stringify(initial.stores.config))
  const projects = liveProjects([initial], () => {}, () => {})
  cleanups.push(() => projects.close())
  const server = await createServer({ projectDir: stores.projectDir, port: 0, ...callbacks(projects) })
  cleanups.push(() => server.close())
  const request = requestAt(server.url)
  const req = await stores.workspaces.createRequirement({ title: '角色热更新' })
  const start = async () => {
    const response = await request('/api/commands/run.start', 'POST', { input: { requirementId: req.id, workflowId: 'work' }, reason: '验证角色' })
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.ok, JSON.stringify(body)).toBe(true)
    await vi.waitFor(async () => expect((await stores.runs.list()).every(run => run.status === 'succeeded')).toBe(true))
  }
  await start()
  expect(calls[0]?.systemAppend).toContain('初始角色正文')
  const role = await (await request('/api/space/agents/dev')).json()
  const saved = await request('/api/space/agents/dev', 'PUT', { baseRevision: role.revision, reason: '更新角色', instructions: '新的角色正文', harness: { harness: 'mock', effort: 'high' }, knowledge: [] })
  expect(saved.status, await saved.text()).toBe(200)
  await start()
  expect(calls).toHaveLength(2)
  expect(calls[1]?.systemAppend).toContain('新的角色正文')
  expect(calls[1]?.effort).toBe('high')
  const current = projects.runtimes.get(stores.projectDir)!.context.profiles.dev!
  expect(current).toMatchObject({ instructions: '新的角色正文', harness: { harness: 'mock', effort: 'high' }, knowledge: [] })
}, 15000)

it('空多空间 serve 动态发现空间后创建唯一命令运行时，自动化 start_workflow 可用且卸载释放', async () => {
  const root = await rootDir()
  const projects = liveProjects([], () => {}, () => {})
  cleanups.push(() => projects.close())
  const unload = vi.fn(projects.remove)
  const server = await createServer({ spacesDir: root, port: 0, ...callbacks(projects), onSpaceUnload: unload })
  cleanups.push(() => server.close())
  const stores = await setupSpace(join(root, 'added'))
  const req = await stores.workspaces.createRequirement({ title: '动态空间自动启动' })
  const request = requestAt(server.url)
  await vi.waitFor(async () => {
    await request('/api/spaces')
    expect(projects.runtimes.has(stores.projectDir)).toBe(true)
  }, { timeout: 8000, interval: 100 })
  const [a, b] = await Promise.all([projects.ensure(stores.projectDir), projects.ensure(stores.projectDir)])
  expect(a).toBe(b)
  const automation = { id: 'start', title: '自动启动', enabled: true, trigger: { event: 'requirement.created' }, action: { kind: 'start_workflow', workflowId: 'work', requirementId: req.id } }
  const saved = await request('/api/s/added/space/automations/start', 'PUT', { automation, reason: '配置自动启动' })
  expect(saved.status, await saved.text()).toBe(200)
  const response = await request('/api/s/added/space/automations/start/trigger', 'POST', { reason: '验证动态命令' })
  const result = await response.json()
  expect(response.status, JSON.stringify(result)).toBe(200)
  expect(result).toMatchObject({ status: 'ok', runId: expect.any(String) })
  await vi.waitFor(async () => {
    const run = await stores.runs.get(result.runId)
    expect(run).toMatchObject({ status: 'succeeded', workflowId: 'work', args: { __taktAutomation: 'start' } })
  })
  const history = await (await request('/api/s/added/space/automations/start/runs')).json()
  expect(history[0]).toMatchObject({ id: result.id, runId: result.runId, status: 'ok' })
  // 只移除配置使发现器卸载空间；目录保留，供旧运行时完成关闭。
  await rm(join(stores.projectDir, 'takt.config.json'))
  await vi.waitFor(() => expect(unload).toHaveBeenCalledWith(stores.projectDir), { timeout: 8000, interval: 100 })
  expect(projects.runtimes.size).toBe(0)
}, 20000)
