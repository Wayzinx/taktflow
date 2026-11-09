import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { initProject } from '../store/project.js'
import { createCommandRegistry } from './index.js'
import type { CommandDeps } from './contracts.js'
const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))) })
const owner = { actor: { type: 'human', id: 'alice' } as const, reason: '验收' }
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'takt-commands-')); roots.push(root)
  const stores = await initProject(root)
  stores.config.members = [{ id: 'alice', role: 'owner', name: 'Alice' }, { id: 'bob', role: 'viewer', name: 'Bob' }, { id: 'member', role: 'member', name: 'Member' }]
  const handler = vi.fn(async (input: unknown) => input)
  const audit = vi.fn(async () => {})
  const deps: CommandDeps = { stores, audit, startRun: handler, resumeRun: handler, retryRun: handler, cancelRun: handler, answerAttention: handler, dispatchTask: handler, disposeReview: handler, setLessonStatus: handler, route: handler }
  return { stores, handler, audit, deps, registry: createCommandRegistry(deps) }
}
it('提供完整命令目录，返回副本不能篡改权限与 schema', async () => {
  const { registry } = await setup()
  expect(registry.list()).toHaveLength(29)
  const cancel = registry.list().find((command) => command.id === 'run.cancel')!
  expect(cancel).toMatchObject({ risk: 'dangerous', minRole: 'maintainer' })
  cancel.minRole = 'viewer'; cancel.input.required = []
  expect(registry.list().find((command) => command.id === 'run.cancel')).toMatchObject({ minRole: 'maintainer', input: { required: ['runId'] } })
})
it.each([
  ['run.start', { requirementId: 'REQ-001', workflowId: 'auto', budget: { tokens: 100, concurrency: 2 } }],
  ['run.retry', { runId: 'run-1', nodeIds: ['work'] }],
  ['run.resume', { runId: 'run-1' }], ['run.cancel', { runId: 'run-1' }],
  ['attention.answer', { requestId: 'request-1', decision: 'approve' }],
  ['route.preview', { requirementId: 'REQ-001', override: { tier: 'T1', reason: '单面' } }],
  ['task.dispatch', { requirementId: 'REQ-001', task: { role: 'dev', title: '修复', instructions: '实现', completion: ['命令执行后返回成功'], impact: 'cosmetic' } }],
  ['review.dispose', { runId: 'run-1', nodeId: 'review', groupKey: 'key', state: 'resolved' }],
  ['lesson.status', { id: 'lesson-1', status: 'active' }],
])('%s 通过注入 handler 执行并审计', async (id, input) => {
  const { registry, handler, audit } = await setup()
  expect(await registry.run(id, input, owner)).toMatchObject({ ok: true, result: input })
  expect(handler).toHaveBeenCalledWith(input, owner)
  expect(audit.mock.calls).toHaveLength(2)
  expect(audit).toHaveBeenLastCalledWith(expect.objectContaining({ id, phase: 'finished', actor: owner.actor, response: expect.objectContaining({ ok: true }) }))
})
it('查询和创建复用存储，不绕过审计', async () => {
  const { registry } = await setup()
  const created = await registry.run('requirement.create', { title: '新需求' }, owner)
  const req = (created.result as { requirement: { id: string } }).requirement
  expect(await registry.run('requirement.status', { requirementId: req.id }, { actor: { type: 'human', id: 'bob' } })).toMatchObject({ ok: true, result: { title: '新需求' } })
  expect(await registry.run('run.status', { runId: 'none' }, owner)).toMatchObject({ ok: true })
  expect(await registry.run('attention.list', {}, owner)).toMatchObject({ ok: true, result: [] })
  expect(await registry.run('lessons.list', {}, owner)).toMatchObject({ ok: true, result: [] })
})
it('写权限、reason、输入 schema 都在 handler 前拒绝；agent 仅 member 权限', async () => {
  const { registry, handler, audit } = await setup()
  const cases = [
    ['run.start', { workflowId: 'auto' }, owner],
    ['run.start', { requirementId: 'REQ-001', workflowId: 'auto', budget: { tokens: '100' } }, owner],
    ['run.resume', { runId: 'r' }, { ...owner, reason: ' ' }],
    ['run.resume', { runId: 'r' }, { ...owner, actor: { type: 'human', id: 'bob' } }],
    ['run.cancel', { runId: 'r' }, { ...owner, actor: { type: 'human', id: 'member' } }],
    ['run.cancel', { runId: 'r' }, { ...owner, actor: { type: 'agent', role: 'lead', harness: 'mock' } }],
    ['run.cancel', { runId: 'r' }, { ...owner, actor: { type: 'system', id: 'lead' } }],
    ['attention.answer', { requestId: 'a', decision: 'approve' }, { ...owner, actor: { type: 'agent', role: 'lead', harness: 'mock' } }],
    ['review.dispose', { runId: 'r', nodeId: 'n', groupKey: 'g', state: 'resolved' }, { ...owner, actor: { type: 'agent', role: 'dev', harness: 'mock' } }],
    ['missing', {}, owner],
  ] as const
  for (const [id, input, context] of cases) expect(await registry.run(id, input, context)).toMatchObject({ ok: false })
  expect(handler).not.toHaveBeenCalled()
  expect(audit.mock.calls).toHaveLength(cases.length)
  expect(await registry.run('run.resume', { runId: 'r' }, { ...owner, actor: { type: 'agent', role: 'lead', harness: 'mock' } })).toMatchObject({ ok: true })
})
it('handler 缺失或异常返回失败；请求审计失败时不执行写入', async () => {
  const { deps, handler } = await setup()
  expect(await createCommandRegistry({ ...deps, startRun: undefined }).run('run.start', { requirementId: 'REQ-1', workflowId: 'auto' }, owner)).toMatchObject({ ok: false, message: expect.stringContaining('未接入') })
  expect(await createCommandRegistry({ ...deps, resumeRun: async () => { throw new Error('依赖不可用') } }).run('run.resume', { runId: 'r' }, owner)).toMatchObject({ ok: false, message: '依赖不可用' })
  await expect(createCommandRegistry({ ...deps, audit: async () => { throw new Error('审计不可用') } }).run('run.resume', { runId: 'r' }, owner)).rejects.toThrow('审计不可用')
  expect(handler).not.toHaveBeenCalled()
})

it('路由预览是只读查询，viewer 无需 reason；未登记用户仍不能访问有成员的空间', async () => {
  const { registry, handler } = await setup()
  expect(registry.list().find((command) => command.id === 'route.preview')).toMatchObject({ kind: 'query', risk: 'read', minRole: 'viewer' })
  const input = { requirementId: 'REQ-001', hint: '小修复' }
  const context = { actor: { type: 'human', id: 'bob' } as const }
  expect(await registry.run('route.preview', input, context)).toMatchObject({ ok: true })
  expect(handler).toHaveBeenCalledWith(input, context)
  expect(await registry.run('route.preview', input, { actor: { type: 'human', id: 'unknown' } })).toMatchObject({ ok: false, message: expect.stringContaining('权限不足') })
})

it.each(['缺省', '空数组'])('成员%s时人类身份按 owner 校验，写原因和 agent 权限仍受约束', async (mode) => {
  const { stores, registry, handler } = await setup()
  stores.config.members = mode === '缺省' ? undefined : []
  const writes = [
    ['run.resume', { runId: 'r' }],
    ['run.cancel', { runId: 'r' }],
    ['attention.answer', { requestId: 'a', decision: 'approve' }],
    ['review.dispose', { runId: 'r', nodeId: 'n', groupKey: 'g', state: 'resolved' }],
    ['lesson.status', { id: 'lesson', status: 'active' }],
  ] as const
  for (const id of ['web', 'demo-owner']) {
    const context = { actor: { type: 'human', id } as const, reason: '本地人工操作' }
    for (const [command, input] of writes) expect(await registry.run(command, input, context)).toMatchObject({ ok: true })
    expect(await registry.run('run.resume', { runId: 'r' }, { actor: context.actor })).toMatchObject({ ok: false, message: '写操作必须说明原因' })
  }
  const agent = { actor: { type: 'agent', role: 'lead', harness: 'mock' } as const, reason: '协调运行' }
  expect(await registry.run('run.cancel', { runId: 'r' }, agent)).toMatchObject({ ok: false, message: expect.stringContaining('权限不足') })
  expect(await registry.run('attention.answer', { requestId: 'a', decision: 'approve' }, agent)).toMatchObject({ ok: false, message: '必须由人显式处理' })
  expect(handler).toHaveBeenCalledTimes(writes.length * 2)
  expect(stores.config.members).toEqual(mode === '缺省' ? undefined : [])
})
