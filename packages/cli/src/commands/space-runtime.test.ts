import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createServer as tcpServer, type AddressInfo } from 'node:net'
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it, vi } from 'vitest'
import { initProject, openProject, type CliHarnessConfig, type ProjectStores, type RoomMessage, type WorkflowDefinition } from '@taktflow/core'

const dirs: string[] = []
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))) })

async function space(dir: string) {
  const stores = await initProject(dir)
  stores.config.workflows = []
  stores.config.lead = { harness: { harness: 'mock' } }
  stores.config.roles = { dev: { harness: 'mock' } }
  await writeFile(join(dir, 'takt.config.json'), JSON.stringify(stores.config))
  await writeFile(join(dir, 'package.json'), '{"type":"module"}')
  await writeFile(join(stores.paths.agents, 'dev.md'), '---\nrole: dev\n---\n开发角色')
  await writeFile(join(stores.taktDir, 'mock.json'), JSON.stringify({ steps: [
    { match: { role: 'dev' }, finalText: 'old-task' },
    { match: { role: 'lead' }, structured: { reply: 'mock-lead', actions: [] } },
  ] }))
  return stores
}

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'takt-spaces-runtime-')); dirs.push(dir)
  const stores = await space(join(dir, 'first'))
  return { dir, stores }
}

function cliHarness(id: string, script: string): CliHarnessConfig {
  return { id, kind: 'cli', command: [process.execPath, '-e', script], available: [process.execPath, '--version'], output: { format: 'text' } }
}

async function serve(spacesDir: string) {
  const reservation = tcpServer()
  reservation.listen(0, '127.0.0.1'); await once(reservation, 'listening')
  const port = (reservation.address() as AddressInfo).port
  await new Promise<void>(resolve => reservation.close(() => resolve()))
  const child = spawn(process.execPath, ['--import', 'tsx', resolve('packages/cli/src/index.ts'), 'serve', '--spaces', spacesDir, '--port', String(port), '--json'], {
    stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, TAKT_SECRETS_FILE: join(spacesDir, 'private/secrets.json') },
  })
  let output = '', errors = '', url = ''
  child.stdout.on('data', chunk => { output += String(chunk) })
  child.stderr.on('data', chunk => { errors += String(chunk) })
  const close = async () => {
    if (child.exitCode !== null || child.signalCode !== null) return
    const exited = once(child, 'exit')
    const timer = setTimeout(() => child.kill('SIGKILL'), 8000)
    child.kill('SIGTERM')
    try { await exited } finally { clearTimeout(timer) }
  }
  try {
    await vi.waitFor(() => {
      if (child.exitCode !== null) throw new Error(`serve 提前退出：${errors} ${output}`)
      url = JSON.parse(output).url
      expect(url).toMatch(/^http:/)
    }, { timeout: 8000, interval: 20 })
  } catch (error) { await close(); throw error }
  const call = async (path: string, method = 'GET', body?: object, status = 200) => {
    const response = await fetch(url + path, { method, headers: { 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) })
    const value = await response.json()
    expect(response.status, JSON.stringify({ value, errors })).toBe(status)
    return value
  }
  return { call, close }
}

async function patch(server: Awaited<ReturnType<typeof serve>>, id: string, changes: object) {
  const path = `/api/s/${id}/space/runtime`
  const before = await server.call(path)
  return server.call(path, 'PATCH', { baseRevision: before.revision, reason: '多空间热更新回归', ...changes })
}

it.each(['启动时存在', '启动后新增'])('多空间：%s的空间 PATCH 后能探测新 ACP harness，配置不会串空间', async (when) => {
  const { dir, stores } = await fixture()
  if (when === '启动时存在') await space(join(dir, 'second'))
  const server = await serve(dir)
  try {
    if (when === '启动后新增') {
      await space(join(dir, 'second'))
      await vi.waitFor(() => server.call('/api/s/second/space/runtime'), { timeout: 8000, interval: 100 })
    }
    const harness = { id: 'goose', kind: 'acp', preset: 'goose', permissions: 'allow', command: [join(dir, 'not-installed-goose')] }
    await patch(server, 'second', { harnesses: { goose: harness } })
    const saved = await server.call('/api/s/second/space/runtime')
    expect(saved.harnesses).toContainEqual(harness)
    const probe = await server.call('/api/s/second/space/runtime/test', 'POST', { target: { kind: 'harness', id: 'goose' } })
    expect(probe).toMatchObject({ ok: false, billed: false, message: expect.stringContaining('ACP 进程启动失败') })
    const other = await server.call('/api/s/first/space/runtime/test', 'POST', { target: { kind: 'harness', id: 'goose' } }, 400)
    expect(other.error).toContain('harness 不存在')
    expect((await openProject(stores.projectDir)).config.harnesses ?? []).toEqual([])
  } finally { await server.close() }
})

it('多空间：在途节点保留旧适配器，后续节点用更新后的适配器，新运行可选新增 harness', async () => {
  const { dir, stores } = await fixture()
  const entered = join(dir, 'entered'), released = join(dir, 'released')
  const old = cliHarness('old-agent', `const fs = require('node:fs'); fs.writeFileSync(${JSON.stringify(entered)}, '');
    const timeout = setTimeout(() => process.exit(1), 15000);
    const timer = setInterval(() => { if (fs.existsSync(${JSON.stringify(released)})) { clearInterval(timer); clearTimeout(timeout); console.log('old-result') } }, 20);`)
  stores.config.harnesses = [old]
  stores.config.roles = { dev: { harness: old.id } }
  await writeFile(join(stores.projectDir, 'takt.config.json'), JSON.stringify(stores.config))
  const workflow: WorkflowDefinition = { id: 'hot', title: 'hot', version: '1', stages: [], nodes: [
    { id: 'first', kind: 'agent', title: 'first', role: 'dev', prompt: 'first' },
    { id: 'second', kind: 'agent', title: 'second', role: 'dev', prompt: 'second', needs: ['first'] },
  ] }
  await writeFile(join(stores.paths.workflows, 'hot.workflow.ts'), `export default ${JSON.stringify(workflow)}`)
  const req = await stores.workspaces.createRequirement({ title: '节点热更新' })
  const server = await serve(dir)
  try {
    const start = () => server.call('/api/s/first/commands/run.start', 'POST', { input: { requirementId: req.id, workflowId: 'hot' }, reason: '启动热更新回归' })
    expect(await start()).toMatchObject({ ok: true })
    await vi.waitFor(() => access(entered), { timeout: 8000, interval: 20 })
    const updated = cliHarness(old.id, "console.log('updated-result')")
    await patch(server, 'first', { harnesses: { [old.id]: updated } })
    await writeFile(released, '')
    const first = await completedRun(stores, 'hot', 1)
    expect(first.nodes.first!.result).toBe('old-result\n')
    expect(first.nodes.second!.result).toBe('updated-result\n')
    const next = cliHarness('new-agent', "console.log('new-result')")
    await patch(server, 'first', { harnesses: { [next.id]: next }, roles: { dev: { harness: next.id } } })
    // 修改普通配置后，getCommands / resolveRuntime 不能把已激活的运行时覆盖回启动版本。
    await server.call('/api/s/first/space/members', 'PUT', { members: [{ id: 'owner', name: 'Owner', role: 'owner' }], reason: '同步普通配置' })
    await server.call('/api/s/first/commands')
    expect(await server.call('/api/s/first/space/runtime/test', 'POST', { target: { kind: 'harness', id: next.id } })).toMatchObject({ ok: true })
    expect(await start()).toMatchObject({ ok: true })
    const second = await completedRun(stores, 'hot', 2)
    expect(second.nodes.first!.result).toBe('new-result\n')
    expect(second.nodes.second!.result).toBe('new-result\n')
  } finally { await writeFile(released, ''); await server.close() }
})

async function completedRun(stores: ProjectStores, workflowId: string, count: number) {
  await vi.waitFor(async () => {
    const runs = (await stores.runs.list()).filter(run => run.workflowId === workflowId)
    expect(runs).toHaveLength(count)
    expect(runs.every(run => run.status === 'succeeded'), JSON.stringify(runs)).toBe(true)
  }, { timeout: 8000, interval: 20 })
  return (await stores.runs.list()).filter(run => run.workflowId === workflowId).sort((a, b) => a.startedAt.localeCompare(b.startedAt)).at(-1)!
}

it('多空间：热更新后重发群聊任务成功，新运行使用新 harness 并持久化回执', async () => {
  const { dir, stores } = await fixture()
  const req = await stores.workspaces.createRequirement({ title: '重发任务' })
  const server = await serve(dir)
  try {
    expect(await server.call('/api/s/first/commands/task.dispatch', 'POST', { input: { requirementId: req.id,
      task: { role: 'dev', title: '检查字段', instructions: '检查字段', review: false } }, reason: '派发测试任务' })).toMatchObject({ ok: true })
    let original!: RoomMessage
    await vi.waitFor(async () => {
      original = (await stores.chat.list(req.id)).find(message => message.refs?.taskRunId && message.receipt?.status === 'sent')!
      expect(original).toBeDefined()
      expect((await stores.runs.get(original.refs!.taskRunId!))?.status).toBe('succeeded')
      expect((await stores.chat.list(req.id)).some(message => message.refs?.taskRunId === original.refs!.taskRunId && message.receipt?.status === 'done')).toBe(true)
    }, { timeout: 8000, interval: 20 })
    const old = (await stores.runs.get(original.refs!.taskRunId!))!
    await stores.chat.post(req.id, { author: { type: 'system', id: 'test' }, kind: 'task', text: '模拟过期回执', replyTo: original.id,
      refs: original.refs, receipt: { status: 'expired', hops: 0, chain: [] } })
    const next = cliHarness('new-task', "console.log('resent-result')")
    await patch(server, 'first', { harnesses: { [next.id]: next }, roles: { dev: { harness: next.id } } })
    const path = `/api/s/first/requirements/${req.id}/room/tasks/${original.id}/resend`
    const retry = await server.call(path, 'POST', { reason: '人工确认后重发' }) as RoomMessage
    expect(retry).toMatchObject({ kind: 'task', replyTo: original.id, receipt: { status: 'sent', note: '人工确认后重发' } })
    expect(retry.refs!.taskRunId).not.toBe(old.runId)
    const run = await completedRun(stores, old.workflowId, 2)
    expect(run.runId).toBe(retry.refs!.taskRunId)
    expect(Object.values(run.nodes).some(node => node.result === 'resent-result\n')).toBe(true)
    const reopened = await openProject(stores.projectDir)
    await vi.waitFor(async () => {
      const messages = await reopened.chat.list(req.id)
      expect(messages).toContainEqual(retry)
      expect(messages.some(message => message.refs?.taskRunId === run.runId && message.receipt?.status === 'done')).toBe(true)
    }, { timeout: 8000, interval: 20 })
    expect((await server.call(path, 'POST', { reason: '重复重发' }, 409)).error).toContain('重发')
  } finally { await server.close() }
})
