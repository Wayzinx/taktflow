import { mkdtemp, readFile, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { initProject } from '../store/project.js'
import { createCommandRegistry } from './index.js'
import { archiveRequirement, createRequirementFull, restoreRequirement, updateRequirement } from './crud-commands.js'
import type { RouteDecision } from '../types.js'
import { sha256 } from '../util/hash.js'
const roots: string[] = []
afterEach(async () => { for (const dir of roots.splice(0)) await rm(dir, { recursive: true, force: true }) })
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'takt-crud-')); roots.push(root)
  const stores = await initProject(root), audit = vi.fn(async () => {})
  stores.config.members = [{ id: 'alice', name: 'Alice', role: 'owner' }, { id: 'bob', name: 'Bob', role: 'viewer' }]
  const route: RouteDecision = { tier: 'T1', workflowId: 'quick-fix', reason: '单面', surfaces: [], roles: [], gates: [], adjustments: [], decidedBy: { type: 'human', id: 'alice' }, at: new Date().toISOString() }
  const preview = vi.fn(async () => route), start = vi.fn(async () => ({ refs: { runId: 'run-1' } }))
  return { root, stores, audit, preview, start, registry: createCommandRegistry({ stores, audit, route: preview, startRun: start }) }
}
const context = { actor: { type: 'human', id: 'alice' } as const, reason: '验证 CRUD' }
it.each([
  [undefined, undefined, '新建需求 默认原因'],
  [' \t\n', ' ', '新建需求 默认原因'],
  ['  请求原因  ', undefined, '  请求原因  '],
  ['请求原因', '  命令原因  ', '  命令原因  '],
])('创建命令和直接创建共用默认原因，并写入审计与输入版本：%s / %s', async (inputReason, commandReason, expected) => {
  const { stores, registry, audit } = await setup()
  const input = { title: '默认原因', start: false, workflowId: 'demo', ...(inputReason === undefined ? {} : { reason: inputReason }) }
  expect((await registry.run('requirement.create', input, { actor: context.actor, reason: commandReason })).ok).toBe(true)
  for (const phase of ['requested', 'finished']) expect(audit).toHaveBeenCalledWith(expect.objectContaining({ phase, reason: expected }))
  const direct = await createRequirementFull({ stores, audit }, input, { actor: context.actor, reason: commandReason })
  for (const id of ['REQ-001', direct.requirement.id]) {
    const prd = (await stores.workspaces.listArtifacts(id)).find((item) => item.path === 'inputs/prd.md')!
    expect(prd.versions[0]?.reason).toBe(expected)
  }
})

it.each(['requirement.update', 'requirement.archive', 'requirement.restore'])('%s 仍要求显式原因', async (id) => {
  const { stores, registry } = await setup()
  const req = await stores.workspaces.createRequirement({ title: '不能自动补原因' })
  for (const reason of [undefined, ' \t\n']) {
    expect(await registry.run(id, { requirementId: req.id }, { actor: context.actor, reason })).toMatchObject({ ok: false, message: '写操作必须说明原因' })
  }
})

it('完整创建持久化字段、清洗附件、在启动前写入 PRD，自动路由并传预算和仓库', async () => {
  const { stores, registry, preview, start, audit } = await setup()
  start.mockImplementationOnce(async () => {
    expect((await stores.workspaces.readArtifact({ workspace: 'REQ-001', path: 'inputs/prd.md' }))?.toString()).toBe('验收标准')
    return { refs: { runId: 'run-1' } }
  })
  const result = await registry.run('requirement.create', { title: '需求', description: '验收标准', owner: 'alice', members: ['bob'], dueAt: '2027-01-01', links: [{ type: 'prd', url: 'https://example.com' }], repos: ['app'], budget: { tokens: 10 }, attachments: [{ name: '../设计 图.txt', content: Buffer.from('附件').toString('base64'), encoding: 'base64' }] }, context)
  expect(result).toMatchObject({ ok: true, result: { runId: 'run-1', requirement: { description: '验收标准', members: ['bob'] }, route: { workflowId: 'quick-fix' } } })
  expect(preview).toHaveBeenCalledWith({ requirementId: 'REQ-001', hint: '验收标准', repos: ['app'] }, context)
  expect(start).toHaveBeenCalledWith(expect.objectContaining({ budget: { tokens: 10 }, args: { repos: ['app'] }, route: expect.objectContaining({ tier: 'T1' }) }), context)
  expect((await stores.workspaces.readArtifact({ workspace: 'REQ-001', path: 'inputs/..设计图.txt' }))?.toString()).toBe('附件')
  expect(await stores.workspaces.getRequirement('REQ-001')).toMatchObject({ owner: 'alice', dueAt: '2027-01-01' })
  expect(audit).toHaveBeenCalledTimes(2)
  expect((await stores.chat.list('REQ-001')).at(-1)?.author).toEqual({ type: 'system', id: 'lead' })
})
it('启动失败保留需求；显式不启动；附件超限或名称冲突在创建前拒绝', async () => {
  const { registry, stores, start } = await setup()
  start.mockRejectedValueOnce(new Error('引擎不可用'))
  expect(await registry.run('requirement.create', { title: '保留', workflowId: 'standard' }, context)).toMatchObject({ ok: true, result: { startError: '引擎不可用' } })
  expect(await stores.workspaces.getRequirement('REQ-001')).toBeTruthy()
  expect(await registry.run('requirement.create', { title: '草稿', workflowId: 'standard', start: false }, context)).toMatchObject({ ok: true, result: { requirement: { id: 'REQ-002' } } })
  expect(start).toHaveBeenCalledTimes(1)
  for (const attachments of [[{ name: 'prd.md', content: '覆盖' }], [{ name: 'large', content: 'x'.repeat(5 * 1024 * 1024 + 1) }], [{ name: 'bad', content: '!@', encoding: 'base64' }]]) expect((await registry.run('requirement.create', { title: '拒绝', attachments }, context)).ok).toBe(false)
  expect(await stores.workspaces.listRequirements()).toHaveLength(2)
})
it('编辑清除日期、归档冲突及无运行恢复为草稿', async () => {
  const { stores } = await setup(), req = await stores.workspaces.createRequirement({ title: '需求' })
  await updateRequirement(stores, req.id, { dueAt: '2027-01-01', reason: '日期' })
  await updateRequirement(stores, req.id, { dueAt: null, reason: '清除' })
  expect((await stores.workspaces.getRequirement(req.id))?.dueAt).toBeUndefined()
  await archiveRequirement(stores, req.id)
  expect((await stores.workspaces.getRequirement(req.id))?.archivedAt).toBeTruthy()
  expect(await restoreRequirement(stores, req.id)).toMatchObject({ status: 'draft', archivedAt: undefined })
  vi.spyOn(stores.runs, 'list').mockResolvedValue([{ status: 'waiting_human' }] as never)
  await expect(archiveRequirement(stores, req.id)).rejects.toMatchObject({ status: 409 })
})
it('文件写入强制权限、限定路径、版本检查、拒绝符号链接并审计', async () => {
  const { stores, root, registry, audit } = await setup()
  expect((await registry.run('file.write', { path: 'agents/a.md', content: '一' }, { ...context, actor: { type: 'human', id: 'bob' } })).ok).toBe(false)
  expect((await registry.run('file.write', { path: 'agents/a.md', content: '一' }, context)).ok).toBe(true)
  expect((await registry.run('file.write', { path: 'agents/a.md', content: '二', baseHash: sha256('旧') }, context)).ok).toBe(false)
  expect(await readFile(join(root, 'agents/a.md'), 'utf8')).toBe('一')
  for (const path of ['../outside', 'workflows/evil.ts', 'knowledge/a.ts', 'agents/../config.json']) expect((await registry.run('file.write', { path, content: 'bad' }, context)).ok).toBe(false)
  await symlink(tmpdir(), join(stores.paths.agents, 'escape'))
  expect((await registry.run('file.write', { path: 'agents/escape/leak', content: 'bad' }, context)).ok).toBe(false)
  expect(audit.mock.calls.some(([entry]) => (entry as unknown as { id: string }).id === 'file.write')).toBe(true)
})
