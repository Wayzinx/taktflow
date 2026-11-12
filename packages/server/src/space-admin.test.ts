import { mkdtemp, mkdir, readFile, rm, writeFile, symlink, copyFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { FsEventStore, openProject } from '@taktflow/core'
import { archiveSpace, createServerCommandRegistry, createSpace, deleteSpace, initSpace, listSpaces, restoreSpace, updateSpace } from './space-admin.js'
import { discoverSpaces, projectCommands } from './space.js'
const roots: string[] = []
const author = { type: 'human', id: 'alice' } as const
const reason = '空间验收'
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
async function root() { const dir = await mkdtemp(join(tmpdir(), 'takt-spaces-')); roots.push(dir); return dir }
it('三种模板、唯一性与点目录发现规则', async () => {
  const spacesDir = await root(), deps = { spacesDir }
  for (const template of ['blank', 'standard', 'quick'] as const) {
    await createSpace(deps, { id: template, name: template, template, reason }, author)
    const stores = await openProject(join(spacesDir, template))
    expect(stores.config.members).toEqual([{ id: 'alice', name: 'alice', role: 'owner' }])
    expect(stores.config.workflows).toHaveLength(template === 'blank' ? 0 : template === 'quick' ? 1 : 2)
  }
  await expect(createSpace(deps, { id: 'another', name: ' S T A N D A R D ', template: 'blank', reason }, author)).rejects.toMatchObject({ status: 409 })
  await expect(createSpace(deps, { id: 'blank', name: 'different', template: 'blank', reason }, author)).rejects.toMatchObject({ status: 409 })
  await expect(createSpace(deps, { id: '../bad', name: 'bad', template: 'blank', reason }, author)).rejects.toMatchObject({ status: 409 })
  for (const name of ['.archive', '.shared', '.steward', '.takt']) await initSpace(join(spacesDir, name), 'blank')
  expect((await discoverSpaces(spacesDir)).map((space) => space.config.project.name).sort()).toEqual(['blank', 'quick', 'standard'])
})
it('按 parts 复制资产与配置，保留源并将创建者设为 owner', async () => {
  const spacesDir = await root(), deps = { spacesDir }
  await createSpace(deps, { id: 'source', name: '来源', template: 'quick', reason }, author)
  const source = await openProject(join(spacesDir, 'source'))
  await writeFile(join(source.paths.skills, 'sample.md'), '技能')
  await writeFile(join(source.paths.knowledge, 'wiki.md'), '知识')
  source.config.members!.push({ id: 'bob', name: 'bob', role: 'maintainer' })
  source.config.models = { model: { provider: 'test', id: 'model' } }
  source.config.providers = { test: { protocol: 'openai', baseUrl: 'http://localhost', apiKeyEnv: 'TEST_KEY' } } as never
  source.config.knowledgeBindings = [{ baseId: 'wiki', enabled: true }] as never
  await writeFile(join(source.projectDir, 'takt.config.json'), JSON.stringify(source.config))
  await createSpace(deps, { id: 'copied', name: '复制', template: { copyFrom: 'source', parts: ['agents', 'skills', 'workflows', 'knowledge', 'models', 'members'] }, reason }, { type: 'human', id: 'bob' })
  const copied = await openProject(join(spacesDir, 'copied'))
  expect(copied.config.models).toEqual(source.config.models)
  expect(copied.config.knowledgeBindings).toEqual(source.config.knowledgeBindings)
  expect(copied.config.workflows).toEqual(['workflows/quick-fix.workflow.ts'])
  expect(copied.config.members).toContainEqual({ id: 'bob', name: 'bob', role: 'owner' })
  expect(await readFile(join(copied.paths.knowledge, 'wiki.md'), 'utf8')).toBe('知识')
  expect(await readFile(join(copied.paths.skills, 'sample.md'), 'utf8')).toBe('技能')
})
it('归档、恢复、删除、权限、审计哈希链', async () => {
  const spacesDir = await root(), deps = { spacesDir, now: () => new Date('2026-11-07T01:02:03Z') }
  await createSpace(deps, { id: 'demo', name: '演示', template: 'blank', reason }, author)
  await updateSpace(deps, 'demo', { name: '新名称', description: '说明', color: '#123456', reason }, author)
  const archived = await archiveSpace(deps, 'demo', author, reason)
  expect(archived.id).toBe('demo@20261107-010203')
  expect(await discoverSpaces(spacesDir)).toEqual([])
  expect(await listSpaces(deps, true)).toMatchObject([{ id: archived.id, archived: true, archivedAt: '2026-11-07T01:02:03Z' }])
  await expect(createSpace(deps, { id: 'demo', name: '复用', template: 'blank', reason }, author)).rejects.toMatchObject({ status: 409 })
  expect((await restoreSpace(deps, archived.id, author, reason)).name).toBe('新名称')
  await archiveSpace(deps, 'demo', author, reason)
  await expect(deleteSpace(deps, archived.id, 'wrong', author, reason)).rejects.toMatchObject({ status: 409 })
  await expect(deleteSpace(deps, archived.id, archived.id, { type: 'human', id: 'bob' }, reason)).rejects.toThrow('权限不足')
  expect(await deleteSpace(deps, archived.id, archived.id, author, reason)).toEqual({ deleted: archived.id })
  // 早期空间没写 space.id，ID 来自目录名；归档后目录名带 @时间戳，列表和恢复都得认回原 ID
  await createSpace(deps, { id: 'legacy', name: '老空间', template: 'blank', reason }, author)
  const legacy = join(spacesDir, 'legacy/takt.config.json'), config = JSON.parse(await readFile(legacy, 'utf8'))
  delete config.space; await writeFile(legacy, JSON.stringify(config))
  const old = await archiveSpace(deps, 'legacy', author, reason)
  expect(await listSpaces(deps, true)).toMatchObject([{ id: old.id, name: '老空间', archived: true }])
  expect((await restoreSpace(deps, old.id, author, reason)).id).toBe('legacy')
  const audit = join(spacesDir, '.takt/space-admin.jsonl'), scratch = await root()
  await mkdir(join(scratch, 'runs/space'), { recursive: true }); await copyFile(audit, join(scratch, 'runs/space/events.jsonl'))
  expect(await new FsEventStore(scratch).verify('space')).toEqual({ ok: true })
})
it('服务端命令表 reason / actor、单空间限制；配置 merge patch 验证及权限审计', async () => {
  const spacesDir = await root(), registry = createServerCommandRegistry({ spacesDir })
  expect(registry.list().map((item) => item.id)).toEqual(['space.create', 'space.update', 'space.archive', 'space.restore', 'space.delete'])
  expect(registry.list().find((item) => item.id === 'space.delete')?.risk).toBe('dangerous')
  expect((await registry.run('space.update', { id: 'demo', name: '演示' }, { actor: author })).ok).toBe(false)
  expect((await registry.run('space.create', { id: 'demo', name: '演示', template: 'blank' }, { actor: { type: 'agent', role: 'lead', harness: 'mock' }, reason })).ok).toBe(false)
  expect((await registry.run('space.create', { id: 'demo', name: '演示', template: 'blank' }, { actor: author, reason })).ok).toBe(true)
  const stores = await openProject(join(spacesDir, 'demo')), commands = projectCommands(stores)
  expect((await commands.run('config.patch', { patch: { project: { description: '说明' }, budget: { tokens: 10 } } }, { actor: author, reason })).ok).toBe(true)
  expect((await commands.run('config.patch', { patch: { project: { description: null } } }, { actor: author, reason })).ok).toBe(true)
  expect((await openProject(stores.projectDir)).config.project.description).toBeUndefined()
  for (const patch of [{ workflows: [] }, { project: { name: null } }, { members: [{ id: 'bad', role: 'admin' }] }, { repos: [{ id: 'bad' }] }, { project: { id: 'bad' } }]) expect((await commands.run('config.patch', { patch }, { actor: author, reason })).ok).toBe(false)
  await expect(createSpace({}, { id: 'no', name: 'no', template: 'blank', reason }, author)).rejects.toMatchObject({ status: 409 })
  const logs = await readFile(join(stores.taktDir, 'space-events.jsonl'), 'utf8')
  expect(logs).toContain('config.patch')
})
it.each([
  [undefined, undefined],
  [' \t\n', ' '],
  ['  请求原因  ', undefined],
  ['请求原因', '  命令原因  '],
])('空间直接创建和命令创建共用默认原因，所有审计保留有效原因：%s / %s', async (inputReason, commandReason) => {
  const spacesDir = await root(), deps = { spacesDir }, registry = createServerCommandRegistry(deps)
  const input = { name: '直接创建', template: 'blank' as const, ...(inputReason === undefined ? {} : { reason: inputReason }) }
  await createSpace(deps, { ...input, id: 'direct' }, author, commandReason)
  expect((await registry.run('space.create', { ...input, id: 'command', name: '命令创建' }, { actor: author, reason: commandReason })).ok).toBe(true)
  const entries = (await readFile(join(spacesDir, '.takt/space-admin.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(JSON.parse(line).data.message))
  const supplied = commandReason?.trim() ? commandReason : inputReason?.trim() ? inputReason : undefined
  expect(entries.map((entry) => entry.reason)).toEqual([supplied ?? '新建空间 direct', ...Array(3).fill(supplied ?? '新建空间 command')])
  for (const id of ['space.update', 'space.archive', 'space.restore']) {
    for (const reason of [undefined, ' \t\n']) expect((await registry.run(id, { id: 'command' }, { actor: author, reason })).ok).toBe(false)
  }
})
it('拒绝符号链接、缺失本地仓库；git URL 只登记', async () => {
  const spacesDir = await root(), deps = { spacesDir }
  await expect(createSpace(deps, { id: 'repo', name: 'repo', template: 'blank', repos: [{ path: '/this-path-does-not-exist' }], reason }, author)).rejects.toMatchObject({ status: 400 })
  await createSpace(deps, { id: 'remote', name: 'remote', template: 'blank', repos: [{ url: 'https://example.com/repo.git', defaultBranch: 'main' }], reason }, author)
  expect((await openProject(join(spacesDir, 'remote'))).config.repos?.[0]?.url).toBe('https://example.com/repo.git')
  await symlink(resolve(tmpdir()), join(spacesDir, 'linked'))
  await expect(createSpace(deps, { id: 'linked', name: 'linked', template: 'blank', reason }, author)).rejects.toMatchObject({ status: 409 })
})
it('M4-27：非成员不能复制私有空间', async () => {
  const spacesDir = await root()
  await createSpace({ spacesDir }, { id: 'private', name: '私有', template: 'blank' }, { type: 'human', id: 'bob' })
  await expect(createSpace({ spacesDir }, {
    id: 'stolen', name: '复制', template: { copyFrom: 'private', parts: ['knowledge', 'models', 'members'] },
  }, author)).rejects.toMatchObject({ status: 403 })
})
it('M4-28：坏配置和重复 ID 不阻断健康空间发现', async () => {
  const spacesDir = await root()
  await createSpace({ spacesDir }, { id: 'good', name: '健康', template: 'blank' }, author)
  await mkdir(join(spacesDir, 'bad'))
  await writeFile(join(spacesDir, 'bad/takt.config.json'), '{broken')
  await mkdir(join(spacesDir, 'duplicate'))
  await copyFile(join(spacesDir, 'good/takt.config.json'), join(spacesDir, 'duplicate/takt.config.json'))
  expect((await discoverSpaces(spacesDir)).map(stores => stores.config.space?.id)).toEqual(['good'])
})
