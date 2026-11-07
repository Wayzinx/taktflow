import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { initProject, openProject, type Actor, type SpaceSettings, type SpaceUpgradePlan } from '@taktflow/core'
import { createApiCore } from './api-core.js'
import { readTemplateDir } from './api-settings.js'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))) })
const owner: Actor = { type: 'human', id: 'owner', via: 'dsh-web' }
const templatesDir = resolve(import.meta.dirname, '../../../templates')
const api = createApiCore({ templates: () => readTemplateDir(templatesDir) })

async function fixture(layout?: 'legacy') {
  const root = await mkdtemp(join(tmpdir(), 'takt-settings-')); roots.push(root)
  const stores = await initProject(root, layout ? { layout } : undefined)
  // 流程校验会真的加载 .workflow.ts：让空间里的 @taktflow/core 解析到本仓库的 core。
  await mkdir(join(root, 'node_modules/@taktflow'), { recursive: true })
  for (const name of ['core', 'sandbox', 'harness', 'knowledge']) await symlink(resolve(import.meta.dirname, '../..', name), join(root, 'node_modules/@taktflow', name))
  await writeFile(join(root, 'package.json'), '{"type":"module"}')
  return { root, stores }
}

async function upgraded() {
  const space = await fixture()
  await api.write(space.stores, 'space.upgrade', {}, { reason: '初始化模板' }, owner)
  space.stores = await openProject(space.root)
  return space
}

const settings = async (stores: Awaited<ReturnType<typeof fixture>>['stores']) => api.read(stores, 'space.settings', {}) as Promise<SpaceSettings>

it('space.upgrade：先预览再执行，补齐模板、登记三个流程并设默认；再次预览没有变更', async () => {
  const { root, stores } = await fixture()
  const before = await settings(stores)
  expect(before.layout.legacy).toBe(true)
  const plan = await api.write(stores, 'space.upgrade', {}, { dryRun: true, reason: '预览' }, owner) as SpaceUpgradePlan
  expect(plan.applied).toBe(false)
  expect(plan.changes.filter((c) => c.kind === 'register-workflow').map((c) => c.target).sort()).toEqual(['quick-fix', 'sdlc', 'taktflow-standard'])
  await expect(readFile(join(root, 'workflows/quick-fix.workflow.ts'))).rejects.toMatchObject({ code: 'ENOENT' })

  const applied = await api.write(stores, 'space.upgrade', {}, { reason: '升级' }, owner) as SpaceUpgradePlan
  expect(applied.applied).toBe(true)
  const config = JSON.parse(await readFile(join(root, 'takt.config.json'), 'utf8'))
  expect(config.workflows.sort()).toEqual(['workflows/quick-fix.workflow.ts', 'workflows/sdlc.workflow.ts', 'workflows/taktflow-standard.workflow.ts'])
  expect(config.route.defaultWorkflow).toBe('taktflow-standard')
  const after = await settings(await openProject(root))
  expect(after.layout.legacy).toBe(false)
  expect(after.workflows.find((w) => w.id === 'taktflow-standard')).toMatchObject({ default: true, registered: true, title: '标准交付流水线（完整）' })
  const again = await api.write(await openProject(root), 'space.upgrade', {}, { dryRun: true, reason: '再看' }, owner) as SpaceUpgradePlan
  expect(again.changes).toEqual([])
})

it('旧布局：悬空引用会被补上而不是删掉，已有角色不覆盖', async () => {
  const { root, stores } = await fixture('legacy')
  await writeFile(join(root, '.takt/agents/dev.md'), '---\nrole: dev\ntitle: 我的开发\nharness: dsh-host\n---\n自定义\n')
  const plan = await api.write(stores, 'space.upgrade', {}, { reason: '升级旧空间' }, owner) as SpaceUpgradePlan
  expect(plan.changes.some((c) => c.kind === 'drop-workflow')).toBe(false)
  expect(plan.changes.some((c) => c.target.endsWith('agents/dev.md'))).toBe(false)
  expect(await readFile(join(root, '.takt/agents/dev.md'), 'utf8')).toContain('我的开发')
  expect(await readFile(join(root, '.takt/workflows/sdlc.workflow.ts'), 'utf8')).toContain("id: 'sdlc'")
})

it('space.settings：结构化角色带使用位置，模板与知识源类型齐全', async () => {
  const { stores } = await upgraded()
  const value = await settings(stores)
  const pm = value.roles.find((role) => role.role === 'pm')!
  expect(pm.file).toBe('agents/pm.md')
  expect(pm.hash).toMatch(/^[a-f0-9]{64}$/)
  expect(pm.usedBy.some((use) => use.workflow === 'taktflow-standard')).toBe(true)
  expect(value.templates.map((t) => t.id).sort()).toEqual(['quick-fix', 'sdlc', 'taktflow-standard'])
  expect(value.knowledgeKinds.map((k) => k.kind)).toEqual(['grep', 'wiki', 'git-history', 'workspace'])
})

it('角色：表单保存只改提到的字段，harness 等保留；过期 baseHash 409；修订可恢复', async () => {
  const { root, stores } = await upgraded()
  await api.write(stores, 'space.skill.save', { name: 'tdd' }, { create: true, description: '先写测试', body: '红-绿-重构', reason: '团队约定' }, owner)
  const original = await readFile(join(root, 'agents/dev.md'), 'utf8')
  const dev = (await settings(stores)).roles.find((role) => role.role === 'dev')!
  const saved = await api.write(stores, 'space.agent.save', { role: 'dev' }, { profile: { title: '开发工程师', skills: ['tdd'] }, baseHash: dev.hash, reason: '加技能' }, owner) as { title: string; skills: string[]; harness: { harness: string } }
  expect(saved).toMatchObject({ title: '开发工程师', skills: ['tdd'], harness: { harness: 'codex' } })
  const text = await readFile(join(root, 'agents/dev.md'), 'utf8')
  expect(text).toContain('writeScope')
  expect(text).toContain('你是开发')

  await expect(api.write(stores, 'space.agent.save', { role: 'dev' }, { profile: { title: '旧页面' }, baseHash: dev.hash, reason: '覆盖' }, owner)).rejects.toMatchObject({ status: 409 })
  await expect(api.write(stores, 'space.agent.save', { role: 'dev' }, { profile: { skills: ['missing'] }, reason: '错' }, owner)).rejects.toMatchObject({ status: 400 })

  const revisions = await api.read(stores, 'space.file.revisions', { kind: 'agent', name: 'dev' }) as Array<{ rev: string; summary: string }>
  expect(revisions.map((r) => r.summary)).toEqual(['修改角色 dev', '初始版本'])
  await api.write(stores, 'space.file.rollback', { kind: 'agent', name: 'dev' }, { rev: revisions[1]!.rev, reason: '撤回' }, owner)
  expect(await readFile(join(root, 'agents/dev.md'), 'utf8')).toBe(original)
})

it('角色：复制新建；被流程使用的不能删，lead 不能删，没人用的可以删', async () => {
  const { root, stores } = await upgraded()
  const created = await api.write(stores, 'space.agent.save', { role: 'security' }, { create: true, copyFrom: 'reviewer', profile: { title: '安全评审', description: '看鉴权与注入' }, reason: '新增安全评审' }, owner) as { role: string; title: string; usedBy: unknown[] }
  expect(created).toMatchObject({ role: 'security', title: '安全评审', usedBy: [] })
  await expect(api.write(stores, 'space.agent.save', { role: 'security' }, { create: true, reason: '重复' }, owner)).rejects.toMatchObject({ status: 409 })
  await expect(api.write(stores, 'space.agent.delete', { role: 'pm' }, { reason: '删' }, owner)).rejects.toMatchObject({ status: 409, detail: { code: 'TAKT_IN_USE' } })
  await expect(api.write(stores, 'space.agent.delete', { role: 'lead' }, { reason: '删' }, owner)).rejects.toMatchObject({ status: 409 })
  await api.write(stores, 'space.agent.delete', { role: 'security' }, { reason: '不要了' }, owner)
  await expect(readFile(join(root, 'agents/security.md'))).rejects.toMatchObject({ code: 'ENOENT' })
})

it('技能：被角色挂着不能删，取下后可删', async () => {
  const { stores } = await upgraded()
  await api.write(stores, 'space.skill.save', { name: 'tdd' }, { create: true, description: '先写测试', body: '…', reason: '加' }, owner)
  await api.write(stores, 'space.agent.save', { role: 'dev' }, { profile: { skills: ['tdd'] }, reason: '挂上' }, owner)
  expect((await settings(stores)).skills.find((s) => s.name === 'tdd')!.usedBy).toEqual(['dev'])
  await expect(api.write(stores, 'space.skill.delete', { name: 'tdd' }, { reason: '删' }, owner)).rejects.toMatchObject({ status: 409 })
  await api.write(stores, 'space.agent.save', { role: 'dev' }, { profile: { skills: [] }, reason: '取下' }, owner)
  await api.write(stores, 'space.skill.delete', { name: 'tdd' }, { reason: '删' }, owner)
  expect((await settings(stores)).skills).toEqual([])
})

it('运行策略：白名单字段校验后落盘，未知字段保留，修订可列出', async () => {
  const { root, stores } = await upgraded()
  const file = join(root, 'takt.config.json')
  await writeFile(file, JSON.stringify({ ...JSON.parse(await readFile(file, 'utf8')), custom: { keep: true } }, null, 2))
  const fresh = await openProject(root)
  await expect(api.write(fresh, 'space.config.update', {}, { patch: { autonomy: 'auto' }, reason: 'x' }, owner)).rejects.toMatchObject({ status: 400 })
  await expect(api.write(fresh, 'space.config.update', {}, { patch: { project: { name: 'x' } }, reason: 'x' }, owner)).rejects.toMatchObject({ status: 400 })
  await expect(api.write(fresh, 'space.config.update', {}, { patch: { environment: { setup: 'npm ci' } }, reason: 'x' }, owner)).rejects.toMatchObject({ status: 400 })
  await expect(api.write(fresh, 'space.config.update', {}, { patch: { knowledge: [{ id: 'docs', kind: 'wiki', options: { root: '../outside' } }] }, reason: 'x' }, owner)).rejects.toMatchObject({ status: 400 })
  const value = await api.write(fresh, 'space.config.update', {}, { patch: {
    autonomy: 'checkpoints', defaultWorkflow: 'quick-fix', selftest: { timeoutMs: 60000 },
    environment: { deploy: 'npm run start', healthcheck: { url: 'http://localhost:3000/health' }, testCommand: 'npm test' },
    knowledge: [{ id: 'docs', kind: 'wiki', options: { root: 'docs' } }],
  }, reason: '团队约定' }, owner) as SpaceSettings
  expect(value.config).toMatchObject({ autonomy: 'checkpoints', defaultWorkflow: 'quick-fix', selftest: { timeoutMs: 60000 }, knowledge: [{ id: 'docs', kind: 'wiki' }] })
  expect(value.workflows.find((w) => w.id === 'quick-fix')!.default).toBe(true)
  const saved = JSON.parse(await readFile(file, 'utf8'))
  expect(saved.custom).toEqual({ keep: true })
  expect(saved.environment.testCommand).toBe('npm test')
  await api.write(fresh, 'space.config.update', {}, { patch: { autonomy: null }, reason: '恢复默认' }, owner)
  expect(JSON.parse(await readFile(file, 'utf8')).autonomy).toBeUndefined()
  const revisions = await api.read(fresh, 'space.file.revisions', { kind: 'config' }) as unknown[]
  expect(revisions.length).toBeGreaterThanOrEqual(3)
})

it('流程：从模板新建、复制、改名、设默认、删除；唯一流程和运行中的流程不能删', async () => {
  const { root, stores } = await upgraded()
  await api.write(stores, 'workflow.create', {}, { id: 'hotfix', title: '线上热修', from: { template: 'quick-fix' }, reason: '加热修流程' }, owner)
  const source = await readFile(join(root, 'workflows/hotfix.workflow.ts'), 'utf8')
  expect(source).toContain("id: 'hotfix'")
  expect(source).toContain("title: '线上热修'")
  await api.write(stores, 'workflow.create', {}, { id: 'std-copy', from: { workflow: 'taktflow-standard' }, reason: '复制' }, owner)
  await expect(api.write(stores, 'workflow.create', {}, { id: 'hotfix', from: { template: 'quick-fix' }, reason: '重复' }, owner)).rejects.toThrow('已存在')
  const listed = await settings(await openProject(root))
  expect(listed.workflows.map((w) => w.id).sort()).toEqual(['hotfix', 'quick-fix', 'sdlc', 'std-copy', 'taktflow-standard'])
  expect(listed.workflows.every((w) => w.registered)).toBe(true)

  await api.write(stores, 'workflow.meta', { id: 'hotfix' }, { title: '紧急修复', default: true, reason: '默认用热修' }, owner)
  expect((await settings(await openProject(root))).workflows.find((w) => w.id === 'hotfix')).toMatchObject({ title: '紧急修复', default: true })

  await api.write(stores, 'workflow.delete', { id: 'hotfix' }, { reason: '不用了' }, owner)
  const config = JSON.parse(await readFile(join(root, 'takt.config.json'), 'utf8'))
  expect(config.workflows).not.toContain('workflows/hotfix.workflow.ts')
  expect(config.route?.defaultWorkflow).toBeUndefined()
  for (const id of ['std-copy', 'sdlc', 'quick-fix']) await api.write(stores, 'workflow.delete', { id }, { reason: '收敛' }, owner)
  await expect(api.write(stores, 'workflow.delete', { id: 'taktflow-standard' }, { reason: '全删' }, owner)).rejects.toMatchObject({ status: 409 })
})

it('权限：代人执行的 agent 按被代表的人算，普通 agent 不能改配置', async () => {
  const { stores } = await upgraded()
  const lead: Actor = { type: 'agent', role: 'lead', harness: 'dsh', onBehalfOf: 'owner' }
  await api.write(stores, 'space.config.update', {}, { patch: { autonomy: 'manual' }, reason: '用户要求全部人审' }, lead)
  const worker: Actor = { type: 'agent', role: 'dev', harness: 'dsh' }
  await expect(api.write(stores, 'space.config.update', {}, { patch: { autonomy: 'full' }, reason: '自己改' }, worker)).rejects.toMatchObject({ status: 403 })
})
