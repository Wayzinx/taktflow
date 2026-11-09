import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { createEngine, createLeadRuntime, initProject, snapshotWorkflow, taskWorkflow, type Engine, type HarnessAdapter, type RunState, type WorkflowDefinition } from '@taktflow/core'
import { createServer } from '@taktflow/server'
import { runtimeCommands } from './command-runtime.js'
import type { ProjectContext } from './project.js'
import { resumeAfterAnswer } from './commands/serve.js'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

async function fixture(fail = false, task = false) {
  const root = await mkdtemp(join(tmpdir(), 'takt-background-')); roots.push(root)
  const stores = await initProject(root)
  const req = await stores.workspaces.createRequirement({ title: '后台续跑' })
  let release!: () => void
  const blocked = new Promise<void>(resolve => { release = resolve })
  const run = vi.fn(async () => { await blocked; if (fail) throw new Error('模拟节点失败'); return { ok: true, finalText: '完成' } })
  const harness: HarnessAdapter = { id: 'mock', displayName: '阻塞式 Mock', capabilities: {}, available: async () => ({ ok: true }), run }
  const context: ProjectContext = { stores, workflows: [], providers: {}, knowledge: [], harnesses: { mock: harness },
    profiles: { worker: { role: 'worker', title: '执行', description: '', instructions: '', writeScope: [], skills: [], harness: { harness: 'mock' } } },
    plugins: { names: [], providers: {}, harnesses: {}, workflows: [], roles: {}, knowledge: [] } }
  const spec = { role: 'worker', title: '临时任务', instructions: '执行', review: false as const }
  const workflow: WorkflowDefinition = task ? taskWorkflow(spec, stores, context.profiles).workflow : { id: 'background', title: '后台', version: '1', stages: [], nodes: [
    { id: 'ask', kind: 'human', title: '回答', ask: '继续？', form: 'answer' },
    { id: 'work', kind: 'agent', title: '执行', role: 'worker', prompt: '执行', needs: ['ask'] },
  ] }
  const trigger = await stores.chat.post(req.id, { author: { type: 'human', id: 'web' }, kind: 'text', text: '继续运行' })
  const resume = vi.fn<Engine['resume']>()
  const lead = createLeadRuntime({ ...context,
    engineFactory: deps => {
      const engine = createEngine({ ...deps, knowledge: [] })
      resume.mockImplementation(engine.resume)
      return { ...engine, resume }
    },
    workflows: { load: async () => workflow, get: async () => ({ rev: '1', source: '' }), replaceSource: async () => {} },
  })
  const commands = runtimeCommands(context, () => lead)
  const runtime = { ...lead, commands }
  const onAnswer = vi.fn(item => resumeAfterAnswer(context, item, runtime))
  const server = await createServer({ projectDir: root, port: 0, getCommands: () => commands, onAnswer })
  const post = (path: string, input: object) => fetch(`${server.url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input), signal: AbortSignal.timeout(3000) })
  const seed = async (live = false) => {
    const state: RunState = { runId: 'interrupted', requirementId: req.id, workflowId: workflow.id, workflowVersion: workflow.version,
      status: 'running', startedAt: new Date().toISOString(), args: task ? { __leadTask: spec } : {}, expansions: [],
      ...(task ? { kind: 'task', origin: { kind: 'chat', messageId: trigger.id, by: trigger.author, title: spec.title } } as const : {}),
      nodes: Object.fromEntries(workflow.nodes.map(node => [node.id, { id: node.id, status: node.kind === 'human' ? 'succeeded' : 'running', attempts: 1, outputs: [] }])) }
    await stores.runs.create(state, snapshotWorkflow(workflow))
    if (live) await writeFile(join(stores.taktDir, 'runs', state.runId, 'lease.json'), JSON.stringify({ pid: process.pid, host: hostname(), startedAt: state.startedAt }))
    return state.runId
  }
  return { stores, req, context, workflow, lead, commands, onAnswer, resume, run, release, seed, post,
    close: async () => { release(); await lead.drain(); await server.close() } }
}

it.each([{ fail: false, task: false }, { fail: true, task: false }, { fail: false, task: true }])('回答 HTTP 在 harness 未结束时返回且只续跑一次；%j', async ({ fail, task }) => {
  const f = await fixture(fail, task)
  const unhandled = vi.fn()
  process.on('unhandledRejection', unhandled)
  try {
    let state: RunState
    if (task) {
      const runId = await f.seed()
      state = (await f.stores.runs.get(runId))!
      state.budget = { tokens: 100_000 }
      await f.stores.runs.save(state)
      await f.stores.events.append(runId, { type: 'harness.usage', actor: { type: 'system', id: 'test' }, data: { inputTokens: 100_000, outputTokens: 0 } })
      state = await createEngine(f.context).resume(runId, f.workflow)
    } else state = await createEngine(f.context).start({ requirementId: f.req.id, workflow: f.workflow })
    expect(state.status).toBe('waiting_human')
    const item = (await f.stores.attention.list({ pending: true }))[0]!
    const response = await f.post(`/api/attention/${encodeURIComponent(item.requestId)}`, task ? { decision: 'choice', answer: '追加 50% 预算' } : { answer: '继续' })
    expect(response.status, await response.text()).toBe(200)
    await vi.waitFor(() => expect(f.run).toHaveBeenCalledTimes(1))
    expect(f.resume).toHaveBeenCalledTimes(1)
    expect(f.onAnswer).not.toHaveBeenCalled()
    expect((await f.stores.runs.get(state.runId))!.status).toBe('running')
    let drained = false
    const draining = f.lead.drain().then(() => { drained = true })
    await new Promise(resolve => setImmediate(resolve))
    expect(drained).toBe(false)
    f.release(); await draining
    expect((await f.stores.runs.get(state.runId))!.status).toBe(fail ? 'failed' : 'succeeded')
    expect(f.lead.getPresence(f.req.id).state).toBe('idle')
    const failures = (await f.stores.chat.list(f.req.id)).filter(message => message.text.includes('运行失败'))
    expect(failures).toHaveLength(fail ? 1 : 0)
    if (fail) expect(failures[0]!.text).toContain('模拟节点失败')
    expect(unhandled).not.toHaveBeenCalled()
  } finally { await f.close(); process.off('unhandledRejection', unhandled) }
})

it.each([false, true])('run.resume 对中断运行开始就返回，后台完成且 drain 等待收尾；task=%s', async task => {
  const f = await fixture(false, task)
  try {
    const runId = await f.seed()
    const response = await f.post('/api/commands/run.resume', { input: { runId }, reason: '恢复中断运行' })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ ok: true })
    await vi.waitFor(() => expect(f.run).toHaveBeenCalledTimes(1))
    expect((await f.stores.runs.get(runId))!.status).toBe('running')
    expect(f.resume).toHaveBeenCalledTimes(1)
    f.release(); await f.lead.drain()
    expect((await f.stores.runs.get(runId))!.status).toBe('succeeded')
    expect(f.lead.getPresence(f.req.id).state).toBe('idle')
  } finally { await f.close() }
})

it('活租约在开始前拒绝命令，HTTP 不返回 200', async () => {
  const f = await fixture()
  try {
    const runId = await f.seed(true)
    const result = await f.commands.run('run.resume', { runId }, { actor: { type: 'human', id: 'web' }, reason: '尝试恢复' })
    expect(result).toMatchObject({ ok: false, message: '运行仍在执行' })
    const response = await f.post('/api/commands/run.resume', { input: { runId }, reason: '尝试恢复' })
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ error: '运行仍在执行' })
    expect(f.run).not.toHaveBeenCalled()
    expect(f.resume).not.toHaveBeenCalled()
  } finally { await f.close() }
})
