import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { initProject } from '../store/project.js'
import { createEngine } from '../engine/index.js'
import { callReadOnly } from '../eval/read-only-call.js'
import type { AgentProfile, HarnessAdapter } from '../types.js'
import { setLocalSecret } from './index.js'

const dirs: string[] = []
afterEach(async () => { vi.unstubAllEnvs(); await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))) })
it('普通节点与只读回放只注入所选 provider 密钥，不污染进程环境', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'takt-secret-injection-')); dirs.push(dir)
  vi.stubEnv('TAKT_SECRETS_FILE', join(dir, 'private/secrets.json'))
  vi.stubEnv('SELECTED_KEY', '')
  await setLocalSecret('SELECTED_KEY', 'synthetic-selected-key')
  await setLocalSecret('UNRELATED_KEY', 'synthetic-unrelated-key')
  const stores = await initProject(join(dir, 'space'))
  stores.config.providers = { selected: { protocol: 'openai-chat', apiKeyEnv: 'SELECTED_KEY' } }
  const profile: AgentProfile = { role: 'dev', title: 'dev', description: '', instructions: '', skills: [], writeScope: [], harness: { harness: 'mock', provider: 'selected', model: 'fake' } }
  const run = vi.fn<HarnessAdapter['run']>(async req => {
    expect(req.env?.SELECTED_KEY).toBe('synthetic-selected-key')
    expect(req.env?.UNRELATED_KEY).toBeUndefined()
    expect(process.env.SELECTED_KEY).toBe('')
    return { ok: true, finalText: 'ok' }
  })
  const harness: HarnessAdapter = { id: 'mock', displayName: 'mock', available: async () => ({ ok: true }), capabilities: { customProvider: true, readOnly: true }, run }
  const deps = { stores, profiles: { dev: profile }, harnesses: { mock: harness }, knowledge: [] }
  const req = await stores.workspaces.createRequirement({ title: 'injection' })
  expect((await createEngine(deps).start({ requirementId: req.id, workflow: { id: 'injection', title: '', version: '1', stages: [], nodes: [
    { id: 'work', kind: 'agent', title: '', role: 'dev', prompt: 'work' },
  ] } })).status).toBe('succeeded')
  await callReadOnly(deps, { cwd: stores.projectDir, prompt: 'review', profile, selector: profile.harness, role: 'reviewer', recipeKey: 'fake' })
  expect(run).toHaveBeenCalledTimes(2)
})
