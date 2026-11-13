import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { createEngine } from './index.js'
import { initProject } from '../store/project.js'
import { agent, human, planner } from '../dsl.js'
import type { AgentProfile, HarnessAdapter, ProviderBridge } from '../types.js'

it.each([false, true])('桥接注入与事件脱敏，成功/失败都关闭路由：%s', async fail => {
  const root = await mkdtemp(join(tmpdir(), 'takt-engine-bridge-'))
  try {
    const stores = await initProject(root)
    stores.config.providers = { chat: { protocol: 'openai-chat', apiKeyEnv: 'UPSTREAM_SECRET' } }
    const requirement = await stores.workspaces.createRequirement({ title: '桥接' })
    const close = vi.fn(async () => {})
    const bridge: ProviderBridge = { supports: () => true, close: async () => {}, open: vi.fn(async () => ({ provider: { id: 'chat', protocol: 'openai-responses', baseURL: 'http://127.0.0.1:12345/r/test/v1', apiKeyEnv: 'TAKT_BRIDGE_TOKEN' }, env: { TAKT_BRIDGE_TOKEN: 'synthetic-bridge-token' }, close })) }
    const harness: HarnessAdapter = { id: 'test', displayName: 'test', capabilities: { customProvider: true, providerProtocols: ['openai-responses'] }, available: async () => ({ ok: true }), run: async (req, emit) => {
      expect(req.provider).toMatchObject({ protocol: 'openai-responses', baseURL: 'http://127.0.0.1:12345/r/test/v1' })
      expect(req.env?.TAKT_BRIDGE_TOKEN).toBe('synthetic-bridge-token')
      expect(req.env?.UPSTREAM_SECRET).toBeUndefined()
      emit({ type: 'message', text: req.env!.TAKT_BRIDGE_TOKEN! })
      if (fail) throw new Error(req.env!.TAKT_BRIDGE_TOKEN)
      return { ok: true, finalText: req.env!.TAKT_BRIDGE_TOKEN! }
    } }
    const engine = createEngine({ stores, profiles: { dev: { role: 'dev', title: '', description: '', instructions: '', skills: [], writeScope: [], harness: { harness: 'test', provider: 'chat', model: 'raw' } } }, harnesses: { test: harness }, bridge, knowledge: [] })
    const state = await engine.start({ requirementId: requirement.id, workflow: { id: 'test', title: '桥接', version: '1', stages: [], nodes: [{ id: 'call', title: '', kind: 'agent', role: 'dev', prompt: 'OK' }] } })
    expect(state.status).toBe(fail ? 'failed' : 'succeeded')
    expect(close).toHaveBeenCalledOnce()
    const events = await stores.events.read(state.runId)
    expect(events.find(e => e.type === 'invocation.started')?.data).toMatchObject({ provider: 'chat', pairing: { mode: 'bridge', protocol: 'openai-responses', upstream: 'openai-chat' } })
    expect(JSON.stringify(events)).not.toContain('synthetic-bridge-token')
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('planner 展开的条目和恢复时重建的条目都按桥接校验，不把可桥接的 provider 判成不兼容', async () => {
  const root = await mkdtemp(join(tmpdir(), 'takt-engine-bridge-planner-'))
  try {
    const stores = await initProject(root)
    stores.config.providers = { chat: { protocol: 'openai-chat', apiKeyEnv: 'UPSTREAM_SECRET' } }
    const requirement = await stores.workspaces.createRequirement({ title: '桥接拆分' })
    const bridge: ProviderBridge = { supports: (protocol, upstream) => protocol === 'openai-responses' && upstream === 'openai-chat', close: async () => {},
      open: async () => ({ provider: { id: 'chat', protocol: 'openai-responses', baseURL: 'http://127.0.0.1:12345/r/test/v1', apiKeyEnv: 'TAKT_BRIDGE_TOKEN' }, env: { TAKT_BRIDGE_TOKEN: 'synthetic-bridge-token' }, close: async () => {} }) }
    const harness: HarnessAdapter = { id: 'test', displayName: 'test', capabilities: { customProvider: true, providerProtocols: ['openai-responses'] }, available: async () => ({ ok: true }),
      run: async (req) => req.provider ? { ok: true, finalText: 'done' } : { ok: true, finalText: '', structured: { items: [{ key: 'a', title: 'A', role: 'dev' }] } } }
    const profile = (role: string, harness: AgentProfile['harness']): AgentProfile => ({ role, title: '', description: '', instructions: '', skills: [], writeScope: [], harness })
    const deps = { stores, profiles: { planner: profile('planner', { harness: 'test' }), dev: profile('dev', { harness: 'test', provider: 'chat', model: 'raw' }) }, harnesses: { test: harness }, bridge, knowledge: [] }
    const def = { id: 'test', title: '桥接拆分', version: '1', stages: [], nodes: [planner({ id: 'p', title: '拆分', role: 'planner', allowedRoles: ['dev'], maxItems: 1, prompt: '',
      expand: item => [human({ id: 'ok', title: '确认', ask: '?', form: 'approve' }), agent({ id: 'impl', title: item.title, role: item.role!, prompt: 'OK', needs: ['ok'] })] })] }
    const paused = await createEngine(deps).start({ requirementId: requirement.id, workflow: def })
    expect(paused.status).toBe('waiting_human')
    const item = (await stores.attention.list())[0]!
    await stores.attention.answer(item.requestId, { decision: 'approve', by: { type: 'human', id: 'reviewer' } })
    const state = await createEngine(deps).resume(paused.runId, def)
    expect(state.status).toBe('succeeded')
    const started = (await stores.events.read(state.runId, { types: ['invocation.started'] })).map(e => e.data as { agentRole: string; pairing?: unknown })
    expect(started.find(e => e.agentRole === 'dev')?.pairing).toEqual({ mode: 'bridge', protocol: 'openai-responses', upstream: 'openai-chat' })
  } finally { await rm(root, { recursive: true, force: true }) }
})

const outputsFixture = async (run: HarnessAdapter['run'], writeScope: string[], resume = false) => {
  const root = await mkdtemp(join(tmpdir(), 'takt-engine-outputs-'))
  const stores = await initProject(root)
  const requirement = await stores.workspaces.createRequirement({ title: '产出' })
  const harness: HarnessAdapter = { id: 'test', displayName: 'test', capabilities: { resume }, available: async () => ({ ok: true }), run: vi.fn(run) }
  const profile: AgentProfile = { role: 'dev', title: '', description: '', instructions: '', skills: [], writeScope, harness: { harness: 'test' } }
  const engine = createEngine({ stores, profiles: { dev: profile }, harnesses: { test: harness }, knowledge: [] })
  const workflow = (nodes: Parameters<typeof engine.start>[0]['workflow']['nodes']) => ({ requirementId: requirement.id, workflow: { id: 'test', title: '产出', version: '1', stages: [], nodes } })
  return { root, stores, workspace: stores.workspaces.dir(requirement.id), harness, engine, workflow }
}

it('声明的产出不在写权限里：静态节点不让启动，拆出的节点开跑前阻塞，通配产出也查', async () => {
  const f = await outputsFixture(async () => ({ ok: true, finalText: 'done', structured: { items: [{ key: 'a', title: 'A' }] } }), ['src/**', '**/reports/**'])
  try {
    await expect(f.engine.start(f.workflow([agent({ id: 'code', title: '', role: 'dev', prompt: '', outputs: [{ path: 'research/review/**', kind: 'report' }] })])))
      .rejects.toThrow(/^节点 code 要产出 research\/review\/\*\*，但角色 dev 的写权限不含它/)
    await expect(f.engine.start(f.workflow([agent({ id: 'code', title: '', role: 'dev', prompt: '', outputs: [{ path: 'tasks/code.md', kind: 'task' }] })]))).rejects.toThrow('tasks/code.md')
    const ok = await f.engine.start(f.workflow([agent({ id: 'code', title: '', role: 'dev', prompt: '', outputs: [{ path: 'reports/**', kind: 'report' }, { path: 'evidence/{a,b}/**', kind: 'evidence', required: false }] })]))
    expect(ok.nodes.code?.error ?? '').not.toContain('写权限不含')
    const state = await f.engine.start(f.workflow([planner({ id: 'p', title: '', role: 'dev', maxItems: 1, prompt: '',
      expand: () => [agent({ id: 'code', title: '', role: 'dev', prompt: '', outputs: [{ path: 'research/**', kind: 'report' }] })] })]))
    expect(state.nodes['p/a/code']).toMatchObject({ status: 'blocked', error: expect.stringContaining('节点 p/a/code 要产出 research/**') })
  } finally { await rm(f.root, { recursive: true, force: true }) }
})

it.each([true, false])('跑完缺必需产物时追问补交，补上就成功（可续聊：%s）', async resume => {
  const prompts: Array<{ prompt: string; sessionId?: string }> = []
  const f = await outputsFixture(async req => {
    prompts.push({ prompt: req.prompt, sessionId: req.sessionId })
    if (prompts.length === 1) return { ok: true, finalText: '结论：通过', sessionId: 's1' }
    await mkdir(join(f.workspace, 'reports'), { recursive: true })
    await writeFile(join(f.workspace, 'reports/review.md'), '结论：通过')
    return { ok: true, finalText: '已补写', sessionId: 's1' }
  }, ['**'], resume)
  try {
    const state = await f.engine.start(f.workflow([agent({ id: 'review', title: '', role: 'dev', prompt: '核验', outputs: [{ path: 'reports/**', kind: 'report' }] })]))
    expect(state.status).toBe('succeeded')
    expect(prompts).toHaveLength(2)
    expect(prompts[1]!.prompt).toContain('你还没有交付必需产物：reports/**')
    expect(prompts[1]!.sessionId).toBe(resume ? 's1' : undefined)
    if (resume) expect(prompts[1]!.prompt).not.toContain('核验')
    else expect(prompts[1]!.prompt).toContain('你上一轮的最终回复：\n结论：通过')
    expect((await f.stores.events.read(state.runId, { types: ['log'] })).map(e => (e.data as { message: string }).message)).toContain('缺少必需产物 reports/**，让 agent 补交（第 1 次）')
  } finally { await rm(f.root, { recursive: true, force: true }) }
})

it('追问补交到上限仍缺产物才失败，并带上 agent 的说明', async () => {
  const f = await outputsFixture(async req => ({ ok: true, finalText: req.prompt.includes('你还没有交付') ? '缺少样本，写不了结论' : '结论' }), ['**'])
  try {
    f.stores.config.output = { repairs: 1 }
    const state = await f.engine.start(f.workflow([agent({ id: 'review', title: '', role: 'dev', prompt: '', outputs: [{ path: 'reports/review.md', kind: 'report' }] })]))
    expect(state.nodes.review).toMatchObject({ status: 'failed', error: '缺少必需产物：reports/review.md（已让 agent 补交 1 次；agent 的说明：缺少样本，写不了结论）' })
    expect(f.harness.run).toHaveBeenCalledTimes(2)
  } finally { await rm(f.root, { recursive: true, force: true }) }
})

it('借用节点定义调用模型的检查（规划、门禁评分、交付复核）不核对也不追问产出', async () => {
  const f = await outputsFixture(async () => ({ ok: true, finalText: 'done', structured: { items: [{ key: 'a', title: 'A' }] } }), [])
  try {
    const state = await f.engine.start(f.workflow([planner({ id: 'p', title: '', role: 'dev', maxItems: 1, prompt: '', outputs: [{ path: 'evidence/**', kind: 'evidence', required: false }],
      expand: () => [human({ id: 'ok', title: '', ask: '?', form: 'approve' })] })]))
    expect(state.status).toBe('waiting_human')
    expect(f.harness.run).toHaveBeenCalledTimes(1)
  } finally { await rm(f.root, { recursive: true, force: true }) }
})
