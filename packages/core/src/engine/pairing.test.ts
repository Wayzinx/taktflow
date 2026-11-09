import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { createEngine } from './index.js'
import { initProject } from '../store/project.js'
import type { HarnessAdapter, ProviderBridge } from '../types.js'

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
