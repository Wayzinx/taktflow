import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createServer as tcpServer, type AddressInfo } from 'node:net'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it, vi } from 'vitest'
import { initProject, type TaktConfig, type WorkflowDefinition } from '@taktflow/core'
import { createHarnesses } from '@taktflow/harness'
import { liveRuntime } from './serve.js'
import { createRunEngine, type ProjectContext } from '../project.js'
import { runtimeHarnesses, runtimeModels } from '../catalog.js'
import { setLocalSecret } from '@taktflow/core'

const dirs: string[] = []
afterEach(async () => { vi.unstubAllEnvs(); await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))) })
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'takt-serve-reload-')); dirs.push(dir)
  vi.stubEnv('TAKT_SECRETS_FILE', join(dir, 'private/secrets.json'))
  const stores = await initProject(join(dir, 'space'))
  const context: ProjectContext = { stores, workflows: [], providers: {}, knowledge: [],
    harnesses: createHarnesses(), profiles: { dev: { role: 'dev', title: 'dev', description: '', instructions: '', writeScope: [], skills: [], harness: { harness: 'mock' } } },
    plugins: { names: [], providers: {}, harnesses: {}, workflows: [], roles: {}, knowledge: [] } }
  return { context, dir }
}
it('热更新后同一运行的新节点选新 harness，在途节点仍返回旧结果', async () => {
  const { context } = await fixture()
  let release!: () => void, started!: () => void
  const pending = new Promise<void>(resolve => { release = resolve })
  const entered = new Promise<void>(resolve => { started = resolve })
  context.harnesses.mock!.run = async () => { started(); await pending; return { ok: true, finalText: 'old-result' } }
  const live = liveRuntime(context)
  const req = await context.stores.workspaces.createRequirement({ title: 'hot reload' })
  const workflow: WorkflowDefinition = { id: 'hot', title: 'hot', version: '1', stages: [], nodes: [
    { id: 'first', kind: 'agent', title: 'first', role: 'dev', prompt: 'first' },
    { id: 'second', kind: 'agent', title: 'second', role: 'dev', prompt: 'second', needs: ['first'] },
  ] }
  const running = createRunEngine(live.context).start({ requirementId: req.id, workflow })
  await entered
  const config: TaktConfig = { ...context.stores.config, roles: { dev: { harness: 'new-agent' } }, harnesses: [
    { id: 'new-agent', kind: 'cli', command: [process.execPath, '-e', "console.log('new-result')"], available: [process.execPath, '--version'], output: { format: 'text' } },
  ] }
  const prepared = live.prepare(config)
  expect(live.context.profiles.dev!.harness.harness).toBe('mock')
  prepared.activate()
  expect(live.context.profiles.dev!.harness.harness).toBe('new-agent')
  release()
  const state = await running
  expect(state.status, JSON.stringify(state.nodes)).toBe('succeeded')
  expect(state.nodes.first!.result).toBe('old-result')
  expect(state.nodes.second!.result).toBe('new-result\n')
  const next = live.prepare({ ...config, roles: { dev: { harness: 'mock' } } })
  next.activate()
  expect(prepared.context.profiles.dev!.harness.harness).toBe('mock')
})
it('停用项不探测且可重新启用；模型目录读取本机来源和 embedding kind', async () => {
  const { context } = await fixture()
  vi.stubEnv('CATALOG_LOCAL_KEY', '')
  await setLocalSecret('CATALOG_LOCAL_KEY', 'synthetic-catalog-local-key')
  context.stores.config.providers = { local: { protocol: 'openai-chat', apiKeyEnv: 'CATALOG_LOCAL_KEY' } }
  context.stores.config.models = { emb: { provider: 'local', id: 'emb', kind: 'embedding', dimensions: 3 } }
  context.stores.config.harnessOverrides = { codex: { disabled: true, command: '/must-not-run' } }
  context.harnesses = createHarnesses({ config: context.stores.config })
  for (const h of Object.values(context.harnesses)) h.available = async () => ({ ok: true })
  expect(context.harnesses.codex).toBeUndefined()
  expect((await runtimeHarnesses(context)).find(h => h.id === 'codex')).toMatchObject({ available: false, reason: '本空间已停用', override: { disabled: true }, command: ['/must-not-run'] })
  expect(runtimeModels(context)).toEqual([expect.objectContaining({ kind: 'embedding', keyPresent: true })])
  context.stores.config.harnessOverrides.codex = { disabled: false, command: '/re-enabled' }
  expect(createHarnesses({ config: context.stores.config }).codex).toBeDefined()
})

it('真实 serve 进程 PATCH 后新 Lead 使用新 CLI，无需重启并可从群聊回读', async () => {
  const { context } = await fixture()
  const { stores } = context
  stores.config.lead = { harness: { harness: 'mock' } }
  stores.config.workflows = []
  await writeFile(join(stores.projectDir, 'takt.config.json'), JSON.stringify(stores.config))
  await writeFile(join(stores.taktDir, 'mock.json'), JSON.stringify({ steps: [{ match: { role: 'lead' }, structured: { reply: 'before-reload', actions: [] } }] }))
  const req = await stores.workspaces.createRequirement({ title: 'Lead reload' })
  const reservation = tcpServer()
  reservation.listen(0, '127.0.0.1'); await once(reservation, 'listening')
  const port = (reservation.address() as AddressInfo).port
  await new Promise<void>(resolve => reservation.close(() => resolve()))
  const child = spawn(process.execPath, ['--import', 'tsx', resolve('packages/cli/src/index.ts'), 'serve', '--project', stores.projectDir, '--port', String(port), '--json'], { stdio: ['ignore', 'pipe', 'pipe'] })
  let output = '', errors = ''
  child.stdout.on('data', chunk => { output += String(chunk) })
  child.stderr.on('data', chunk => { errors += String(chunk) })
  try {
    let url = ''
    await vi.waitFor(() => {
      if (child.exitCode !== null) throw new Error(`serve 提前退出：${errors} ${output}`)
      url = JSON.parse(output).url
      expect(url).toMatch(/^http:/)
    }, { timeout: 8000, interval: 20 })
    const post = (path: string, body: object, method = 'POST') => fetch(url + path, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    expect((await post(`/api/requirements/${req.id}/chat`, { text: '@lead before' })).status).toBe(200)
    await vi.waitFor(async () => {
      expect((await stores.chat.list(req.id)).some(message => message.text === 'before-reload')).toBe(true)
      expect((await stores.runs.list()).every(run => run.status === 'succeeded')).toBe(true)
    }, { timeout: 8000, interval: 20 })
    const before = await (await fetch(url + '/api/space/runtime')).json()
    const replyScript = `console.log(${JSON.stringify('```json\n{"reply":"after-reload","actions":[]}\n```')})`
    const patched = await post('/api/space/runtime', { baseRevision: before.revision, reason: '切换 Lead',
      harnesses: { 'next-lead': { id: 'next-lead', kind: 'cli', command: [process.execPath, '-e', replyScript], available: [process.execPath, '--version'], output: { format: 'text' } } },
      system: { lead: { harness: 'next-lead' } },
    }, 'PATCH')
    expect(patched.status, JSON.stringify(await patched.json())).toBe(200)
    expect((await post(`/api/requirements/${req.id}/chat`, { text: '@lead after' })).status).toBe(200)
    await vi.waitFor(async () => {
      const messages = await stores.chat.list(req.id)
      expect(messages.some(message => message.text === 'after-reload'), JSON.stringify({ messages, runs: await stores.runs.list(), errors })).toBe(true)
    }, { timeout: 8000, interval: 20 })
    expect(child.exitCode).toBeNull()
  } finally {
    if (child.exitCode === null) { const exited = once(child, 'exit'); child.kill('SIGTERM'); await exited }
  }
}, 20000)
