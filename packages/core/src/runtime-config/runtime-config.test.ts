import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it } from 'vitest'
import { initProject } from '../store/project.js'
import type { TaktConfig } from '../types.js'
import { applyRuntimePatch, patchRuntimeConfig, readRuntimeConfig, runtimeRevision } from './index.js'

const options = { builtinHarnesses: ['mock', 'codex', 'native'], acpPresets: ['gemini'], providerPresets: ['openai'] }
const config: TaktConfig = { project: { name: '原样保留' }, workflows: [], lead: { progressUpdates: true, maxHops: 8 },
  lessons: { enabled: true, dailyCalls: 3 }, route: { defaultWorkflow: 'standard' } }
const patch = (extra: object, source = config) => ({ baseRevision: runtimeRevision(source), reason: '  原样原因  ', ...extra })
const dirs: string[] = []
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { force: true, recursive: true }))) })

it('规范化哈希忽略对象键序与无关段；读视图只包含运行时段', () => {
  const first = { ...config, roles: { dev: { harness: 'mock' }, test: { harness: 'codex' } } }
  const second = { ...config, project: { name: 'different' }, roles: { test: { harness: 'codex' }, dev: { harness: 'mock' } } }
  expect(runtimeRevision(first)).toBe(runtimeRevision(second))
  expect(readRuntimeConfig(first, { providers: [], acp: [] })).not.toHaveProperty('project')
})
it('系统角色精确映射，未提交键与同段其他键保留；null 只删除对应项', () => {
  const first = applyRuntimePatch(config, patch({ system: { lead: { harness: 'mock' }, route: { harness: 'mock' }, steward: { harness: 'codex' }, learner: { harness: 'mock' } } }), options)
  expect(first.config.lead).toEqual({ progressUpdates: true, maxHops: 8, harness: { harness: 'mock' } })
  expect(first.config.route).toEqual({ defaultWorkflow: 'standard', harness: { harness: 'mock' } })
  expect(first.config.lessons).toEqual({ enabled: true, dailyCalls: 3, learner: { harness: 'mock' } })
  const next = applyRuntimePatch(first.config, patch({ system: { lead: null, learner: null } }, first.config), options)
  expect(next.config.lead).toEqual(config.lead)
  expect(next.config.lessons).toEqual(config.lessons)
  expect(next.config.steward).toEqual({ harness: { harness: 'codex' } })
  expect(next.reason).toBe('  原样原因  ')
})
it.each([
  [{ models: { bad: { provider: 'absent', id: 'x' } } }, 'models.bad.provider'],
  [{ providers: { bad: { protocol: 'typo' } } }, 'providers.bad.protocol'],
  [{ roles: { dev: { harness: 'absent' } } }, 'roles.dev.harness'],
  [{ harnessOverrides: { codex: { disabled: true } }, roles: { dev: { harness: 'codex' } } }, 'roles.dev.harness'],
  [{ roles: { dev: { harness: 'mock', fallback: [{ harness: 'absent' }] } } }, 'roles.dev.fallback.0.harness'],
  [{ harnesses: { codex: { id: 'codex', kind: 'acp', preset: 'gemini' } } }, 'harnesses.codex'],
  [{ harnesses: { own: { id: 'own', kind: 'acp' } } }, 'harnesses.own'],
  [{ harnesses: { own: { id: 'different', kind: 'acp', preset: 'gemini' } } }, 'harnesses.own.id'],
  [{ providers: { p: { protocol: 'openai-chat' } }, models: { m: { provider: 'p', id: 'emb', kind: 'embedding' } } }, 'models.m.dimensions'],
  [{ system: { invalid: { harness: 'mock' } } }, 'system.invalid'],
  [{ roles: [] }, 'roles'],
  [{ project: { name: 'forbidden' } }, 'patch.project'],
])('非法补丁指明字段且不修改源配置：%j', (input, field) => {
  const before = structuredClone(config)
  expect(() => applyRuntimePatch(config, patch(input), options)).toThrow(field)
  expect(config).toEqual(before)
})
it('遮盖值回填沿用旧配置且不将明文写入调用者请求', () => {
  const source = { ...config, harnessOverrides: { codex: { env: { NORMAL: 'old-value' } } } }
  const input = patch({ harnessOverrides: { codex: { env: { NORMAL: '[REDACTED]' } } } }, source)
  expect(applyRuntimePatch(source, input, options).config.harnessOverrides?.codex?.env?.NORMAL).toBe('old-value')
  expect(JSON.stringify(input)).not.toContain('old-value')
})
it('持锁检查 revision，保留其他段及键顺序；审计仅键名和原样 reason', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'takt-runtime-patch-')); dirs.push(dir)
  const stores = await initProject(dir)
  await writeFile(join(dir, 'takt.config.json'), JSON.stringify(config))
  const input = patch({ providers: { local: { protocol: 'openai-chat', baseURL: 'http://example.invalid' } } })
  const outcomes = await Promise.allSettled([patchRuntimeConfig(stores, input, { type: 'human', id: 'owner' }, options), patchRuntimeConfig(stores, input, { type: 'human', id: 'owner' }, options)])
  expect(outcomes.filter(r => r.status === 'fulfilled')).toHaveLength(1)
  expect(outcomes.find(r => r.status === 'rejected')).toMatchObject({ reason: { status: 409 } })
  const persisted = JSON.parse(await readFile(join(dir, 'takt.config.json'), 'utf8'))
  expect(Object.keys(persisted).slice(0, 5)).toEqual(Object.keys(config))
  expect(persisted.project).toEqual(config.project)
  const audit = await readFile(join(dir, '.takt/space-events.jsonl'), 'utf8')
  expect(audit).toContain('providers.local')
  expect(audit).toContain('  原样原因  ')
  expect(audit).not.toContain('http://example.invalid')
})
it('运行时预构建失败不落盘也不写审计', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'takt-runtime-prepare-')); dirs.push(dir)
  const stores = await initProject(dir)
  const before = await readFile(join(dir, 'takt.config.json'), 'utf8')
  await expect(patchRuntimeConfig(stores, patch({ roles: { dev: { harness: 'mock' } } }, stores.config), { type: 'human', id: 'owner' },
    { ...options, prepare: async () => { throw new Error('prepare failed') } })).rejects.toThrow('prepare failed')
  expect(await readFile(join(dir, 'takt.config.json'), 'utf8')).toBe(before)
  await expect(readFile(join(dir, '.takt/space-events.jsonl'))).rejects.toMatchObject({ code: 'ENOENT' })
})
