import { mkdtemp, rm } from 'node:fs/promises'
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

it('声明的产出不在写权限里时开跑前就阻塞，不白跑一整轮', async () => {
  const root = await mkdtemp(join(tmpdir(), 'takt-engine-outputs-'))
  try {
    const stores = await initProject(root)
    const requirement = await stores.workspaces.createRequirement({ title: '产出越界' })
    const run = vi.fn(async () => ({ ok: true, finalText: 'done' }))
    const harness: HarnessAdapter = { id: 'test', displayName: 'test', available: async () => ({ ok: true }), run }
    const profile: AgentProfile = { role: 'dev', title: '', description: '', instructions: '', skills: [], writeScope: ['src/**'], harness: { harness: 'test' } }
    const state = await createEngine({ stores, profiles: { dev: profile }, harnesses: { test: harness }, knowledge: [] }).start({ requirementId: requirement.id,
      workflow: { id: 'test', title: '产出越界', version: '1', stages: [], nodes: [agent({ id: 'code', title: '实现', role: 'dev', prompt: 'OK', outputs: [{ path: 'tasks/code.md', kind: 'task' }, { path: 'evidence/**', kind: 'evidence' }] })] } })
    expect(state.nodes.code).toMatchObject({ status: 'blocked', error: expect.stringMatching(/^节点要产出 \S+tasks\/code\.md，但角色 dev 的写权限不含它：\["src\/\*\*"\]/) })
    expect(run).not.toHaveBeenCalled()
  } finally { await rm(root, { recursive: true, force: true }) }
})
