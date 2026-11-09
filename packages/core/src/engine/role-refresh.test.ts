import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it } from 'vitest'
import { initProject } from '../store/project.js'
import { parseRoleProfile } from '../store/role-profile.js'
import { selectHarness } from './selection.js'
import { createEngine } from './index.js'
import { agent, defineWorkflow } from '../dsl.js'
import type { HarnessAdapter } from '../types.js'
const roots: string[] = []
afterEach(async () => { for (const r of roots.splice(0)) await rm(r, { recursive: true, force: true }) })
it('与引擎共用选择函数：节点 > 档案 > 空间 > mock', () => {
  const inherited = parseRoleProfile('---\ntitle: 开发\n---\n正文', 'dev')
  const context = { config: { project: { name: 'test' }, workflows: [], roles: { dev: { harness: 'space' } } }, profiles: { dev: inherited }, harnesses: {} }
  expect(selectHarness('dev', undefined, context)).toEqual({ harness: 'space' })
  expect(selectHarness('dev', undefined, { ...context, config: { ...context.config, roles: {} } })).toEqual({ harness: 'mock' })
  context.profiles.dev = parseRoleProfile('---\nharness: role\n---\n正文', 'dev')
  expect(selectHarness('dev', undefined, context)).toEqual({ harness: 'role' })
  expect(selectHarness('dev', { harness: 'node' }, context)).toEqual({ harness: 'node' })
})
it('启动时读取新档案覆盖缓存；未写 harness 使用空间路由，已有档案保持优先', async () => {
  const root = await mkdtemp(join(tmpdir(), 'takt-role-refresh-')); roots.push(root)
  const stores = await initProject(root)
  stores.config.roles = { dev: { harness: 'space' } }
  const req = await stores.workspaces.createRequirement({ title: '角色刷新' })
  const calls: string[] = []
  const adapter = (id: string): HarnessAdapter => ({ id, displayName: id, available: async () => ({ ok: true }), run: async request => { calls.push(id); expect(request.systemAppend).toContain('新正文'); return { ok: true, finalText: '完成' } } })
  const engine = createEngine({ stores, profiles: { dev: parseRoleProfile('---\nharness: stale\n---\n旧正文', 'dev') }, harnesses: { space: adapter('space'), role: adapter('role') }, knowledge: [] })
  const workflow = defineWorkflow({ id: 'roles', title: '角色', version: '1', stages: [], nodes: [agent({ id: 'work', title: '工作', role: 'dev', prompt: 'test' })] })
  await writeFile(join(stores.paths.agents, 'dev.md'), '---\ntitle: 开发\n---\n新正文')
  expect((await engine.start({ workflow, requirementId: req.id })).status).toBe('succeeded')
  await writeFile(join(stores.paths.agents, 'dev.md'), '---\nharness: role\n---\n新正文')
  expect((await engine.start({ workflow, requirementId: req.id })).status).toBe('succeeded')
  expect(calls).toEqual(['space', 'role'])
})
