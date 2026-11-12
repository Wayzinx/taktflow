import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { hostname } from 'node:os'
import type { EventStore } from '../interfaces.js'
import type { EventEnvelope, EventType } from '../types.js'
import { leadContext } from './context.js'
import { createCommandRegistry } from '../commands/index.js'
import { snapshotWorkflow } from '../store/snapshot.js'
import { recordTaskImpact } from './task-impact.js'
import { recoverTaskReceipts } from './receipts.js'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { initProject, openProject } from '../store/project.js'
import { matchGlob } from '../util/glob.js'
import { createEngine } from '../engine/index.js'
import type { AgentProfile, HarnessAdapter, HarnessRequest, LeadAction, LeadTurn, TaskSpec, WorkflowDefinition } from '../types.js'
import { createLeadRuntime, taskWorkflow, type LeadWorkflowAccess, type TaskRunState } from './index.js'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))) })
const profile = (role: string, scope: string[] = []): AgentProfile => ({ role, title: role, description: role, instructions: `角色说明 ${role}`, harness: { harness: 'mock' }, writeScope: scope, skills: [] })
async function setup(turns: Array<LeadTurn | Record<string, unknown>>, hooks: { lead?: (request: HarnessRequest) => Promise<void>; task?: (request: HarnessRequest) => Promise<void>; workflows?: LeadWorkflowAccess; layout?: 'space' | 'legacy' } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'takt-lead-test-')); roots.push(root)
  const stores = await initProject(root, { layout: hooks.layout })
  stores.config.lead = { harness: { harness: 'mock' }, progressUpdates: true }
  stores.config.members = [{ id: 'alice', name: 'Alice', role: 'owner' }, { id: 'bob', name: 'Bob', role: 'member' }]
  const requirement = await stores.workspaces.createRequirement({ title: '需求', owner: 'alice' })
  const folder = hooks.layout === 'legacy' ? '.takt/workspaces' : 'requirements'
  const profiles = { lead: profile('lead'), pm: profile('pm', [`${folder}/**/spec/**`]), reviewer: profile('reviewer') }
  const requests: HarnessRequest[] = []
  let index = 0
  const harness: HarnessAdapter = { id: 'mock', displayName: 'Mock', capabilities: { structuredOutput: true }, available: async () => ({ ok: true }),
    async run(request) {
      requests.push(request)
      if (request.env?.TAKT_ROLE === 'lead') {
        await hooks.lead?.(request)
        return { ok: true, finalText: '', structured: turns[index++] }
      }
      if (request.env?.TAKT_ROLE === 'reviewer') return { ok: true, finalText: '', structured: { verdict: 'approve', summary: '通过', issues: [] } }
      await hooks.task?.(request)
      return { ok: true, finalText: '任务完成' }
    },
  }
  const options = { stores, profiles, harnesses: { mock: harness }, engineFactory: (deps: Parameters<Parameters<typeof createLeadRuntime>[0]['engineFactory']>[0]) => createEngine({ ...deps, knowledge: [] }), workflows: hooks.workflows }
  const lead = createLeadRuntime(options)
  const message = (text = '@lead 进展', by = 'alice') => stores.chat.post(requirement.id, { kind: 'text', author: { type: 'human', id: by }, text })
  const send = async () => lead.onMessage(requirement.id, await message())
  return { root, stores, requirement, profiles, requests, lead, options, message, send }
}
const task = (overrides: Partial<TaskSpec> = {}): TaskSpec => ({ role: 'pm', title: '修改 AC-2', instructions: '修改 PRD AC-2', inputs: ['spec/prd.md'], outputs: [{ path: 'spec/prd.md', kind: 'spec' }], writeScope: ['requirements/**/spec/**'], ...overrides })

it('前台 resumeTask 保留执行期 rejection，不把运行中状态当作成功返回', async () => {
  const { stores, lead, requirement, message, options } = await setup([])
  const dispatched = await lead.executeAction({ type: 'dispatch_task', task: task({ inputs: [], outputs: [], review: false }) }, requirement.id, await message(), undefined, 0)
  await lead.drain()
  const state = (await stores.runs.get(dispatched.refs!.taskRunId!))!
  await stores.runs.save({ ...state, status: 'running' })
  const failing = createLeadRuntime({ ...options, engineFactory: deps => ({ ...options.engineFactory(deps),
    resume: async (_id, _workflow, opts) => { opts?.onStarted?.(); throw new Error('模拟执行期存储异常') },
  }) })
  await expect(failing.resumeTask(state.runId, { foreground: true })).rejects.toThrow('模拟执行期存储异常')
})

it.each([true, false])('重发创建新运行并在原 Lead 运行记账；无父运行仍可重发（parent=%s）', async parent => {
  const spec = task({ inputs: [], outputs: [], review: false })
  const action = { type: 'dispatch_task', task: spec } as const
  const { lead, stores, requirement, message, send, options } = await setup([{ reply: '派发', actions: [action] }])
  const turn = parent ? (await send())! : undefined
  const dispatched = turn?.results[0] ?? await lead.executeAction(action, requirement.id, await message(), undefined, 0)
  expect(dispatched.ok).toBe(true)
  await lead.drain()
  const runId = dispatched.refs!.taskRunId!
  const state = (await stores.runs.get(runId))!
  state.origin = { ...state.origin!, hops: 3, chain: ['upstream'] }
  await stores.runs.save(state)
  const original = (await stores.chat.list(requirement.id)).find(item => item.refs?.taskRunId === runId && item.receipt?.status === 'sent')!
  await stores.chat.post(requirement.id, { author: original.author, kind: 'task', text: '待人工确认', refs: original.refs, receipt: { status: 'uncertain', hops: 3, chain: ['upstream'] } })
  // 重新打开运行时后仍从持久化派发事件找到父运行，不能依赖内存映射。
  const restarted = createLeadRuntime({ ...options, stores: await openProject(stores.projectDir) })
  await expect(restarted.resendTask(requirement.id, original, '')).rejects.toThrow('填写原因')
  const retry = await restarted.resendTask(requirement.id, original, '人工核对后重发')
  await restarted.drain()
  expect(retry.refs!.taskRunId).not.toBe(runId)
  expect(retry.receipt).toMatchObject({ status: 'sent', note: '人工核对后重发', hops: 3, chain: ['upstream'] })
  expect(await stores.runs.get(retry.refs!.taskRunId!)).toMatchObject({ args: state.args, origin: { ...state.origin!, messageId: original.id } })
  if (turn) {
    const events = await stores.events.read(turn.run.runId, { types: ['task.dispatched'] })
    expect(events).toHaveLength(2)
    expect(events[0]!.data).not.toHaveProperty('resendOf')
    expect(events[1]).toMatchObject({ runId: turn.run.runId, type: 'task.dispatched', actor: { type: 'agent', role: 'lead' },
      data: { taskRunId: retry.refs!.taskRunId, resendOf: runId, reason: '人工核对后重发', role: spec.role, title: spec.title, by: original.author } })
    expect(events[1]!.seq).toBeGreaterThan(events[0]!.seq)
    expect(Number.isFinite(Date.parse(events[1]!.ts))).toBe(true)
    expect(await stores.events.verify(turn.run.runId)).toEqual({ ok: true })
    await stores.chat.post(requirement.id, { author: original.author, kind: 'task', text: '再次过期', refs: retry.refs, receipt: { status: 'expired' } })
    const again = await restarted.resendTask(requirement.id, retry, '再次人工确认')
    await restarted.drain()
    expect((await stores.events.read(turn.run.runId, { types: ['task.dispatched'] })).at(-1)!.data)
      .toMatchObject({ taskRunId: again.refs!.taskRunId, resendOf: retry.refs!.taskRunId, reason: '再次人工确认' })
  } else {
    for (const run of await stores.runs.list()) expect(await stores.events.read(run.runId, { types: ['task.dispatched'] })).toEqual([])
  }
  expect(await stores.chat.list(requirement.id)).toContainEqual(original)
  await expect(restarted.resendTask(requirement.id, original, '重复重发')).rejects.toThrow('不能重复重发')
})

it('启动恢复能识别真实 Lead 任务正在本进程执行，任务退出后释放执行记录', async () => {
  let release!: () => void
  const blocked = new Promise<void>(resolve => { release = resolve })
  const { stores, lead, requirement, send } = await setup([{ reply: '派发', actions: [{ type: 'dispatch_task', task: task({ inputs: [], outputs: [], review: false }) }] }], { task: () => blocked })
  const turn = (await send())!
  const runId = turn.results[0]!.refs!.taskRunId!
  try {
    await vi.waitFor(async () => expect((await stores.chat.list(requirement.id)).some(item => item.refs?.taskRunId === runId && item.receipt?.status === 'started')).toBe(true))
    await stores.chat.post(requirement.id, { author: { type: 'system', id: 'test' }, kind: 'task', text: '测试接手回执', refs: { taskRunId: runId }, receipt: { status: 'taken' } })
    expect(await recoverTaskReceipts(await openProject(stores.projectDir))).toEqual([])
  } finally { release(); await lead.drain() }
  const state = (await stores.runs.get(runId))!
  state.status = 'running'; delete state.endedAt
  await stores.runs.save(state)
  await stores.chat.post(requirement.id, { author: { type: 'system', id: 'test' }, kind: 'task', text: '模拟遗留状态', refs: { taskRunId: runId }, receipt: { status: 'sent' } })
  expect((await recoverTaskReceipts(stores)).map(item => item.refs?.taskRunId)).toEqual([runId])
})

it.each([true, false])('request_human 透传假设与时限，动作时限优先于空间默认：%s', async override => {
  const timebox = { remindAfter: '5m', handbackAfter: '10m' }
  const { stores, send } = await setup([{ reply: '请确认', actions: [{ type: 'request_human', to: 'alice', ask: '使用默认方案？', form: 'answer', assumption: '默认方案', ...(override ? { timebox } : {}) }] }])
  stores.config.human = { remindAfter: '1h', handbackAfter: '2h' }
  const turn = await send()
  expect(turn!.results[0]!.ok).toBe(true)
  const item = (await stores.attention.list())[0]!
  const expected = { assumption: '默认方案', timebox: override ? timebox : stores.config.human }
  expect(item).toMatchObject({ ...expected, assignees: ['alice'] })
  expect((await stores.events.read(item.runId, { types: ['human.requested'] }))[0]!.data).toMatchObject(expected)
})

it('同需求回合串行；私聊可触发；普通消息和 Lead 自己的消息不触发', async () => {
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  let active = 0; let maximum = 0; let count = 0
  const setupResult = await setup([{ reply: '一', actions: [] }, { reply: '二', actions: [] }], {
    lead: async () => { active++; maximum = Math.max(maximum, active); if (++count === 1) await gate; active-- },
  })
  const { lead, requirement, message, stores } = setupResult
  const first = lead.onMessage(requirement.id, await message())
  await vi.waitFor(() => expect(count).toBe(1), { timeout: 60_000 })
  const second = lead.onMessage(requirement.id, await message('私聊'), { private: true })
  await new Promise<void>((resolve) => setImmediate(resolve))
  expect(count).toBe(1); release()
  await Promise.all([first, second]); expect(maximum).toBe(1)
  expect(await lead.onMessage(requirement.id, await message('普通讨论'))).toBeUndefined()
  expect(await lead.onMessage(requirement.id, await stores.chat.post(requirement.id, { author: { type: 'agent', role: 'lead', harness: 'mock' }, kind: 'text', text: '@lead' }))).toBeUndefined()
  expect(await stores.runs.list()).toHaveLength(2)
})

it('上下文包含角色、快照、最近 30 条消息与备忘；Lead 为只读 task 审计运行', async () => {
  const { stores, lead, requirement, requests, message } = await setup([{ reply: '无运行，等待需求', actions: [] }])
  await stores.workspaces.writeArtifact({ ref: { workspace: requirement.id, path: 'lead-notes.md' }, content: '备忘123', kind: 'other', author: { type: 'human', id: 'alice' }, reason: '测试' })
  for (let i = 0; i < 35; i++) await message(`群消息-${i}-结束`)
  const trigger = await message()
  const result = (await lead.onMessage(requirement.id, trigger))!
  expect(requests[0]!.prompt).toContain('备忘123')
  expect(requests[0]!.prompt).toContain('群消息-34-结束')
  expect(requests[0]!.prompt).not.toContain('群消息-0-结束')
  expect(requests[0]!.prompt).toContain('attention')
  expect(requests[0]!.systemAppend).toContain('角色说明 lead')
  expect(requests[0]!.resultSchema?.title).toBe('LeadTurn')
  expect(requests[0]!.tools).toMatchObject({ writeScope: [], allowBash: false })
  const run = (await stores.runs.get(result.run.runId)) as TaskRunState
  expect(run, JSON.stringify(run.nodes)).toMatchObject({ kind: 'task', workflowId: 'lead', origin: { messageId: trigger.id, by: trigger.author } })
  expect(Object.keys(run.nodes)).toEqual(['lead'])
  expect(await stores.events.verify(run.runId)).toEqual({ ok: true })
  expect((await stores.events.read(run.runId)).some((event) => event.actor.type === 'agent' && event.actor.role === 'lead')).toBe(true)
})

it('禁止动作与非法参数逐条失败，后续合法动作仍执行', async () => {
  const { send, stores, requirement } = await setup([{ reply: '校验', actions: [
    { type: 'approve', requestId: 'other' }, { type: 'write_code', content: '坏代码' }, { type: 'dispatch_task', task: { role: 'missing', title: 'x', instructions: 'x' } },
    { type: 'request_human', to: 'alice', ask: 3, form: 'answer' }, { type: 'update_notes', content: '合法备忘' },
  ] }])
  const result = (await send())!
  expect(result.results.map((item) => item.ok)).toEqual([false, false, false, false, true])
  expect(result.results[0]!.message).toContain('禁止')
  expect((await stores.workspaces.readArtifact({ workspace: requirement.id, path: 'lead-notes.md' }))?.toString()).toBe('合法备忘')
  expect((await stores.chat.list(requirement.id)).filter((message) => message.text.includes('失败'))).toHaveLength(4)
})

it.each(['space', 'legacy'] as const)('dispatch_task 在 %s 布局生成 agent → review 运行、版本和任务状态卡片', async (layout) => {
  const spec = task({ writeScope: [layout === 'space' ? 'requirements/**/spec/**' : '.takt/workspaces/**/spec/**'] })
  const { stores, lead, requirement, message } = await setup([{ reply: '派发产品', actions: [{ type: 'dispatch_task', task: spec }] }], {
    layout, task: async (request) => { await writeFile(join(request.env!.TAKT_WORKSPACE!, 'spec/prd.md'), 'AC-2：新描述') },
  })
  await stores.workspaces.writeArtifact({ ref: { workspace: requirement.id, path: 'spec/prd.md' }, content: 'AC-2：旧描述', kind: 'spec', author: { type: 'human', id: 'alice' }, reason: '初版' })
  const trigger = await message()
  const result = (await lead.onMessage(requirement.id, trigger))!
  expect(result.results[0]!.ok).toBe(true)
  await lead.drain()
  const reopened = await openProject(stores.projectDir)
  const run = (await reopened.runs.get(result.results[0]!.refs!.taskRunId!)) as TaskRunState
  expect(run, JSON.stringify(run.nodes)).toMatchObject({ kind: 'task', workflowId: 'task:pm', status: 'succeeded', origin: { messageId: trigger.id, by: trigger.author } })
  expect(Object.keys(run.nodes)).toEqual(['task', 'review'])
  expect((await reopened.workspaces.listArtifacts(requirement.id)).find((record) => record.path === 'spec/prd.md')!.versions).toHaveLength(2)
  expect((await reopened.chat.list(requirement.id)).filter((message) => message.kind === 'task' && message.refs?.taskRunId === run.runId).map((message) => message.text).join('\n')).toContain('succeeded')
  expect((await reopened.chat.getRoom(requirement.id))!.members.some((member) => member.role === 'pm')).toBe(true)
  for (const state of await reopened.runs.list()) expect(await reopened.events.verify(state.runId)).toEqual({ ok: true })
})

it('TaskSpec 复用角色写权限的交集，review=false 仅产生一个节点；非法评审和路径不产生运行', async () => {
  const { stores, profiles, send } = await setup([{ reply: '拒绝', actions: [
    { type: 'dispatch_task', task: task({ role: 'lead' }) }, { type: 'dispatch_task', task: task({ inputs: ['../secret'] }) },
    { type: 'dispatch_task', task: task({ review: { reviewers: ['pm'], maxRounds: 1 } }) }, { type: 'dispatch_task', task: task({ review: { reviewers: ['reviewer'], maxRounds: 0 } }) },
  ] }])
  const generated = taskWorkflow(task({ writeScope: ['**'], review: false }), stores, profiles)
  expect(generated.workflow.nodes).toHaveLength(1)
  expect(generated.profiles.pm!.writeScope.some((pattern) => matchGlob(pattern, 'requirements/REQ-001/spec/prd.md'))).toBe(true)
  expect(generated.profiles.pm!.writeScope.some((pattern) => matchGlob(pattern, 'src/code.ts'))).toBe(false)
  expect((await send())!.results.every((result) => !result.ok)).toBe(true)
  expect(await stores.runs.list()).toHaveLength(1)
})

it('request_human 建立待办和 attention 卡片，Lead 不能回答或代批', async () => {
  const { stores, requirement, send, lead } = await setup([{ reply: '请确认', actions: [{ type: 'request_human', to: 'alice', ask: '是否上线？', form: 'approve' }] }])
  const result = (await send())!.results[0]!
  const item = (await stores.attention.list({ pending: true }))[0]!
  expect(item.requestId).toBe(result.refs!.requestId)
  expect((await stores.chat.list(requirement.id)).some((message) => message.kind === 'attention' && message.refs?.requestId === item.requestId && message.mentions?.includes('alice'))).toBe(true)
  await expect(lead.onAttention(item)).rejects.toThrow('必须由人')
  const answered = await stores.attention.answer(item.requestId, { decision: 'approve', by: { type: 'human', id: 'alice' } })
  expect(await lead.onAttention(answered)).toBe(true)
})

it('workflow 修改持久化审批基线；重建运行时后批准才应用，记录 Lead 作者与审批人且幂等', async () => {
  const replaceSource = vi.fn(async () => ({ rev: 'next' }))
  const workflows: LeadWorkflowAccess = { get: async () => ({ rev: 'base', source: '旧源码' }), load: async () => { throw new Error('unused') }, replaceSource }
  const { stores, send, options } = await setup([{ reply: '提出修改', actions: [{ type: 'propose_workflow_change', workflowId: 'sdlc', description: '增加评审', source: '新源码' }] }], { workflows })
  const result = (await send())!
  expect(result.results[0]).toMatchObject({ action: 'propose_workflow_change', ok: true })
  expect(replaceSource).not.toHaveBeenCalled()
  const pending = (await stores.attention.list({ pending: true }))[0]!
  const answered = await stores.attention.answer(pending.requestId, { decision: 'approve', by: { type: 'human', id: 'alice' } })
  const restarted = createLeadRuntime(options)
  expect(await restarted.onAttention(answered)).toBe(true)
  expect(await restarted.onAttention(answered)).toBe(true)
  expect(replaceSource).toHaveBeenCalledTimes(1)
  expect(replaceSource).toHaveBeenCalledWith('sdlc', expect.objectContaining({ source: '新源码', baseRev: 'base', author: expect.objectContaining({ role: 'lead' }), onBehalfOf: { type: 'human', id: 'alice' } }))
  expect(await stores.events.verify(result.run.runId)).toEqual({ ok: true })
})

it('workflow 修改被拒绝或产生冲突时不报应用成功', async () => {
  const replaceSource = vi.fn(async () => ({ error: 'conflict' }))
  const workflows: LeadWorkflowAccess = { get: async () => ({ rev: 'base', source: '' }), load: async () => { throw new Error('unused') }, replaceSource }
  const { stores, lead, send, requirement } = await setup([{ reply: '提案', actions: [
    { type: 'propose_workflow_change', workflowId: 'sdlc', description: '一', source: '一' }, { type: 'propose_workflow_change', workflowId: 'sdlc', description: '二', source: '二' },
  ] }], { workflows })
  await send()
  const pending = await stores.attention.list({ pending: true })
  await lead.onAttention(await stores.attention.answer(pending[0]!.requestId, { decision: 'reject', by: { type: 'human', id: 'alice' } }))
  expect(replaceSource).not.toHaveBeenCalled()
  const answered = await stores.attention.answer(pending[1]!.requestId, { decision: 'approve', by: { type: 'human', id: 'alice' } })
  await expect(lead.onAttention(answered)).rejects.toThrow('冲突')
  expect((await stores.chat.list(requirement.id)).some((message) => message.text.includes('已应用'))).toBe(false)
})

it('没带源码的 workflow 修改提案直接退回，不生成批了也应用不了的审批', async () => {
  const replaceSource = vi.fn(async () => ({ rev: 'next' }))
  const workflows: LeadWorkflowAccess = { get: async () => ({ rev: 'base', source: '旧源码' }), load: async () => { throw new Error('unused') }, replaceSource }
  const { stores, send } = await setup([{ reply: '提案', actions: [{ type: 'propose_workflow_change', workflowId: 'sdlc', description: '修执行配置' }] }], { workflows })
  const result = (await send())!.results[0]!
  expect(result).toMatchObject({ action: 'propose_workflow_change', ok: false, message: expect.stringContaining('管家') })
  expect(await stores.attention.list({ pending: true })).toEqual([])
  expect(replaceSource).not.toHaveBeenCalled()
})

it('update_notes 产生可追溯版本，重复相同内容不伪造版本', async () => {
  const { stores, requirement, send } = await setup([
    { reply: '记下了', actions: [{ type: 'update_notes', content: '第一版' }] },
    { reply: '更新', actions: [{ type: 'update_notes', content: '第二版' }, { type: 'update_notes', content: '第二版' }] },
  ])
  await send(); await send()
  const artifact = (await stores.workspaces.listArtifacts(requirement.id))[0]!
  expect(artifact.path).toBe('lead-notes.md'); expect(artifact.versions).toHaveLength(2)
  expect(artifact.versions[1]!.producedBy?.nodeId).toBe('lead')
})

it('progressUpdates 用模板发送阶段、结束、待办等关键事件，忽略逐轮评审和打回过程，不调用 harness；关闭时不发送', async () => {
  const { stores, requirement, lead, requests } = await setup([])
  const workflow: WorkflowDefinition = { id: 'progress', title: '进度', version: '1', stages: [{ id: 'build', title: '研发' }], nodes: [{ id: 'build', kind: 'script', title: '研发', stage: 'build', run: async () => {} }] }
  const state = await createEngine({ stores, profiles: {}, harnesses: {}, knowledge: [] }).start({ workflow, requirementId: requirement.id })
  const finish = (await stores.events.read(state.runId)).find((event) => event.type === 'node.finished')!
  await lead.onRunEvent(state.runId, finish); await lead.onRunEvent(state.runId, finish)
  for (const event of [
    await stores.events.append(state.runId, { type: 'human.requested', actor: { type: 'system', id: 'test' }, data: { requestId: 'attention', ask: '人工确认', form: 'approve' } }),
    await stores.events.append(state.runId, { type: 'review.round', actor: { type: 'system', id: 'test' }, nodeId: 'review', data: { round: 1, passed: false, verdicts: [] } }),
    await stores.events.append(state.runId, { type: 'rework.started', actor: { type: 'system', id: 'test' }, data: { from: 'review', to: 'build', count: 1, feedback: '补充说明', reset: ['build'] } }),
    (await stores.events.read(state.runId)).find((event) => event.type === 'run.finished')!,
  ]) await lead.onRunEvent(state.runId, event)
  const progress = (await stores.chat.list(requirement.id)).filter((message) => message.author.type === 'agent' && message.author.role === 'lead' && message.kind === 'progress')
  expect(progress).toHaveLength(3)
  expect(progress.map((message) => message.text).join('\n')).toContain('阶段完成：研发')
  expect(requests).toEqual([])
  stores.config.lead!.progressUpdates = false
  await lead.onRunEvent(state.runId, await stores.events.append(state.runId, { type: 'run.finished', actor: { type: 'system', id: 'test' }, data: { status: 'succeeded' } }))
  expect((await stores.chat.list(requirement.id)).filter((message) => message.author.type === 'agent')).toHaveLength(3)
})

it('取消受 maintainer 权限限制；运行始终限定于当前需求', async () => {
  const { stores, lead, requirement, message } = await setup([])
  const waiting: WorkflowDefinition = { id: 'waiting', title: '等人', version: '1', stages: [], nodes: [{ id: 'approve', kind: 'human', title: '确认', ask: '确认？', form: 'approve' }] }
  const run = await createEngine({ stores, profiles: {}, harnesses: {}, knowledge: [] }).start({ workflow: waiting, requirementId: requirement.id })
  const turns = [
    { reply: '取消', actions: [{ type: 'cancel_run', runId: run.runId, reason: '停止需求' }] },
    { reply: '取消', actions: [{ type: 'cancel_run', runId: run.runId, reason: '停止需求' }] },
  ]
  const harness: HarnessAdapter = { id: 'mock', displayName: 'Mock', capabilities: { structuredOutput: true }, available: async () => ({ ok: true }), run: async () => ({ ok: true, finalText: '', structured: turns.shift() }) }
  const runtime = createLeadRuntime({ stores, profiles: {}, harnesses: { mock: harness }, engineFactory: (deps) => createEngine({ ...deps, knowledge: [] }) })
  expect((await runtime.onMessage(requirement.id, await message('@lead 取消', 'bob')))!.results[0]!.ok).toBe(false)
  expect((await stores.runs.get(run.runId))!.status).toBe('waiting_human')
  expect((await runtime.onMessage(requirement.id, await message('@lead 取消', 'alice')))!.results[0]!.ok).toBe(true)
  expect((await stores.runs.get(run.runId))!.status).toBe('cancelled')
  expect(await lead.onMessage(requirement.id, await message('普通消息'))).toBeUndefined()
})

it('start_run 启动普通 workflow；resume_run 不代答人工待办，人工答复后才继续', async () => {
  const workflow: WorkflowDefinition = { id: 'approval', title: '确认', version: '1', stages: [], nodes: [{ id: 'approve', kind: 'human', title: '审批', ask: '确认？', form: 'approve' }] }
  const turns: LeadTurn[] = [{ reply: '启动', actions: [{ type: 'start_run', workflowId: workflow.id }] }]
  const { stores, lead, send } = await setup(turns, { workflows: { load: async () => workflow, get: async () => ({ source: '', rev: 'base' }), replaceSource: async () => undefined } })
  const started = (await send())!.results[0]!
  await lead.drain()
  expect(started.ok, started.message).toBe(true)
  const runId = started.refs!.runId!
  expect(await stores.runs.get(runId)).toMatchObject({ workflowId: workflow.id, status: 'waiting_human', kind: 'workflow' })
  turns.push({ reply: '继续', actions: [{ type: 'resume_run', runId }] })
  await send()
  await lead.drain()
  expect((await stores.runs.get(runId))!.status).toBe('waiting_human')
  const item = (await stores.attention.list({ pending: true })).find((item) => item.runId === runId)!
  await stores.attention.answer(item.requestId, { decision: 'approve', by: { type: 'human', id: 'alice' } })
  turns.push({ reply: '继续', actions: [{ type: 'resume_run', runId }] })
  await send()
  await lead.drain()
  expect((await stores.runs.get(runId))!.status).toBe('succeeded')
})

it('临时任务评审进入人工裁决后，重建运行时可从保存的 TaskSpec 恢复，保留 origin 和写权限', async () => {
  const { stores, lead, send, options, requests } = await setup([{ reply: '派发', actions: [{ type: 'dispatch_task', task: task({ review: { reviewers: ['reviewer'], maxRounds: 1 } }) }] }], {
    task: async (request) => { await writeFile(join(request.env!.TAKT_WORKSPACE!, 'spec/prd.md'), '新 PRD') },
  })
  const original = options.harnesses.mock.run
  options.harnesses.mock.run = async (request, emit) => request.env?.TAKT_ROLE === 'reviewer'
    ? { ok: true, finalText: '', structured: { verdict: 'reject', summary: '需要人工决策', issues: [] } }
    : original(request, emit)
  const requirement = (await stores.workspaces.listRequirements())[0]!
  await stores.workspaces.writeArtifact({ ref: { workspace: requirement.id, path: 'spec/prd.md' }, content: '旧 PRD', kind: 'spec', author: { type: 'human', id: 'alice' }, reason: '初版' })
  const result = (await send())!
  await lead.drain()
  const runId = result.results[0]!.refs!.taskRunId!
  const before = await stores.runs.get(runId)
  expect(before!.status).toBe('waiting_human')
  expect((await stores.chat.list(requirement.id)).filter(message => message.refs?.taskRunId === runId).at(-1)!.receipt?.status).toBe('started')
  const item = (await stores.attention.list({ pending: true })).find((item) => item.runId === runId)!
  const answered = await stores.attention.answer(item.requestId, { decision: 'choice', answer: '放行', by: { type: 'human', id: 'alice' } })
  const restarted = createLeadRuntime(options)
  expect(await restarted.onAttention(answered)).toBe(true)
  await restarted.drain()
  expect(await stores.runs.get(runId)).toMatchObject({ status: 'succeeded', origin: (before as TaskRunState).origin })
  expect(requests.filter((request) => request.env?.TAKT_ROLE === 'pm')).toHaveLength(1)
  expect(await stores.events.verify(runId)).toEqual({ ok: true })
})

it('失败任务留在 failed，Lead 任务卡片不声称成功；进度投影跨运行时去重', async () => {
  const { stores, lead, send, options, requirement } = await setup([{ reply: '派发', actions: [{ type: 'dispatch_task', task: task({ inputs: [], review: false }) }] }])
  const result = (await send())!
  await lead.drain()
  const runId = result.results[0]!.refs!.taskRunId!
  expect((await stores.runs.get(runId))!.status).toBe('failed')
  const messages = await stores.chat.list(requirement.id)
  expect(messages.some((message) => message.kind === 'task' && message.text.includes('failed'))).toBe(true)
  expect(messages.some((message) => message.kind === 'task' && message.text.includes('succeeded'))).toBe(false)
  const restarted = createLeadRuntime(options)
  for (const event of await stores.events.read(runId)) await restarted.onRunEvent(runId, event)
  expect(await stores.chat.list(requirement.id)).toHaveLength(messages.length)
})

it('派发后的后台任务可在进行中由后续 Lead 回合查询状态', async () => {
  let taskWrite!: () => void
  let finishLead!: () => void
  const writeGate = new Promise<void>((resolve) => { taskWrite = resolve })
  const leadGate = new Promise<void>((resolve) => { finishLead = resolve })
  let leadCalls = 0
  const { stores, lead, send, requirement } = await setup([
    { reply: '派发', actions: [{ type: 'dispatch_task', task: task({ inputs: [], review: false }) }] },
    { reply: '任务正在处理', actions: [] },
  ], {
    lead: async () => { if (++leadCalls === 2) { taskWrite(); await leadGate } },
    task: async (request) => { await writeGate; await mkdir(join(request.env!.TAKT_WORKSPACE!, 'spec'), { recursive: true }); await writeFile(join(request.env!.TAKT_WORKSPACE!, 'spec/prd.md'), '并发完成'); finishLead() },
  })
  await send()
  try { await expect(send()).resolves.toMatchObject({ run: { status: 'succeeded' } }) }
  finally { await lead.drain() }
  expect((await stores.workspaces.readArtifact({ workspace: requirement.id, path: 'spec/prd.md' }))?.toString()).toBe('并发完成')
})

it('并发派发同角色任务时，每次 harness 调用仍取得各自收窄后的写权限', async () => {
  let ready!: () => void
  const gate = new Promise<void>((resolve) => { ready = resolve })
  let started = 0
  const { stores, lead, send, requests, requirement } = await setup([{ reply: '派发两个任务', actions: ['a', 'b'].map((name) => ({ type: 'dispatch_task', task: task({
    title: `任务-${name}`, instructions: `只写 ${name}.md`, inputs: [], outputs: [{ path: `spec/${name}.md`, kind: 'spec' }], writeScope: [`requirements/**/spec/${name}.md`], review: false,
  }) })) }], { task: async (request) => {
    if (++started === 2) ready()
    await gate
    const name = request.prompt.includes('只写 a.md') ? 'a' : 'b'
    await mkdir(join(request.env!.TAKT_WORKSPACE!, 'spec'), { recursive: true })
    await writeFile(join(request.env!.TAKT_WORKSPACE!, `spec/${name}.md`), name)
  } })
  await send(); await lead.drain()
  const taskRequests = requests.filter((request) => request.env?.TAKT_ROLE === 'pm')
  expect(taskRequests).toHaveLength(2)
  for (const request of taskRequests) {
    const name = request.prompt.includes('只写 a.md') ? 'a' : 'b'
    expect(request.tools!.writeScope.some((pattern) => matchGlob(pattern, `requirements/${requirement.id}/spec/${name}.md`))).toBe(true)
    expect(request.tools!.writeScope.some((pattern) => matchGlob(pattern, `requirements/${requirement.id}/spec/${name === 'a' ? 'b' : 'a'}.md`))).toBe(false)
  }
  expect((await stores.runs.list()).every((run) => run.status === 'succeeded')).toBe(true)
})

it('Lead 上下文按稳定到易变顺序组装；仅触发反馈变化时前缀逐字节相同', async () => {
  const { stores, requirement, message } = await setup([])
  const workflow: WorkflowDefinition = { id: 'main', title: '流程', version: '1', stages: [], nodes: [], leadInstructions: '本流程先核对 AC' }
  await createEngine({ stores, profiles: {}, harnesses: {}, knowledge: [] }).start({ workflow, requirementId: requirement.id })
  await stores.workspaces.writeArtifact({ ref: { workspace: requirement.id, path: 'lead-notes.md' }, kind: 'other', content: '需要保留的备忘', author: { type: 'human', id: 'alice' }, reason: '测试' })
  const trigger = await message('第一个问题')
  const context = { instructions: '角色原文逐字保留', commands: createCommandRegistry({ stores, audit: async () => {} }).list() }
  const first = await leadContext(stores, requirement.id, trigger, context)
  const second = await leadContext(stores, requirement.id, { ...trigger, text: '第二个问题' }, context)
  expect(first.split('本次触发消息：')[0]).toBe(second.split('本次触发消息：')[0])
  const positions = ['角色原文逐字保留', '本流程先核对 AC', '动作：', '命令清单：', 'lead-notes.md：', '状态快照：', '最近 30 条群消息：', '本次触发消息：'].map((text) => first.indexOf(text))
  expect(positions.every((position) => position >= 0)).toBe(true)
  expect(positions).toEqual([...positions].sort((a, b) => a - b))
})

it('auto 单元测试（内存事件存储）：先发路由卡再启动，透传档位预算并发 route.decided', async () => {
  const workflow: WorkflowDefinition = { id: 'quick-fix', title: '轻量流程', version: '1', stages: [], tiers: ['T0', 'T1'], nodes: [
    { id: 'work', kind: 'script', title: '实现', run: async () => {} },
  ] }
  const { options, stores, requirement, message } = await setup([{ reply: '按形状选择流程', actions: [{ type: 'start_run', workflowId: 'auto', budget: { tokens: 100000, concurrency: 1 } }] }])
  stores.events = memoryEvents()
  let cardBeforeLoad = false
  const lead = createLeadRuntime({ ...options, workflows: {
    list: async () => [{ id: workflow.id, snapshot: snapshotWorkflow(workflow) }],
    load: async (id) => { expect(id).toBe('quick-fix'); cardBeforeLoad = (await stores.chat.list(requirement.id)).some((message) => message.kind === 'route'); return workflow },
    get: async () => ({ source: '', rev: 'base' }), replaceSource: async () => undefined,
  } })
  const result = (await lead.onMessage(requirement.id, await message('@lead 优化界面文案')))!
  expect(result.results[0]!.ok, result.results[0]!.message).toBe(true)
  await lead.drain()
  const runId = result.results[0]!.refs!.runId!
  expect(cardBeforeLoad).toBe(true)
  expect(await stores.runs.get(runId)).toMatchObject({ args: { tier: 'T1' }, budget: { tokens: 100000, concurrency: 1 }, route: { tier: 'T1', workflowId: 'quick-fix' } })
  expect((await stores.events.read(runId, { types: ['route.decided'] }))).toHaveLength(1)
  expect((await stores.chat.list(requirement.id)).filter((message) => message.kind === 'route')).toHaveLength(1)
})

it('Lead 专用动作使用注入注册表；command 仅允许 read 并把查询结果显示在群里', async () => {
  const { options, stores, requirement, message } = await setup([{ reply: '处理请求', actions: [
    { type: 'start_run', workflowId: 'custom' },
    { type: 'command', id: 'requirement.status' },
    { type: 'command', id: 'run.cancel', input: { runId: 'other' } },
  ] }])
  const start = vi.fn(async () => ({ runId: 'injected-run' }))
  const audit = vi.fn(async () => {})
  const registry = createCommandRegistry({ stores, audit, startRun: start })
  const run = vi.spyOn(registry, 'run')
  const lead = createLeadRuntime({ ...options, commands: registry })
  const result = (await lead.onMessage(requirement.id, await message()))!
  expect(result.results.map((result) => result.ok)).toEqual([true, true, false])
  expect(result.results[0]!.refs?.runId).toBe('injected-run')
  expect(start).toHaveBeenCalledOnce()
  expect(run.mock.calls.map(([id]) => id)).toEqual(['run.start', 'requirement.status'])
  expect((await stores.chat.list(requirement.id)).some((message) => message.text.includes('command：成功') && message.text.includes(requirement.id))).toBe(true)
  expect(audit).toHaveBeenCalledWith(expect.objectContaining({ id: 'run.start', actor: { type: 'human', id: 'alice' }, reason: expect.stringContaining('Lead 响应消息') }))
})

it('状态灯覆盖 thinking、working、idle，回调不重复通知同状态', async () => {
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  const { options, stores, requirement, message } = await setup([{ reply: '派发', actions: [{ type: 'dispatch_task', task: task({ inputs: [], review: false }) }] }], {
    task: async (request) => { await gate; await mkdir(join(request.env!.TAKT_WORKSPACE!, 'spec'), { recursive: true }); await writeFile(join(request.env!.TAKT_WORKSPACE!, 'spec/prd.md'), '内容') },
  })
  const onPresence = vi.fn()
  const lead = createLeadRuntime({ ...options, onPresence })
  expect(lead.getPresence(requirement.id).state).toBe('idle')
  await lead.onMessage(requirement.id, await message())
  try {
    expect(lead.getPresence(requirement.id).state).toBe('working')
    expect(onPresence.mock.calls.map(([, presence]) => presence.state)).toEqual(['thinking', 'working'])
  } finally { release(); await lead.drain() }
  expect(lead.getPresence(requirement.id).state).toBe('idle')
  expect(onPresence.mock.calls.map(([, presence]) => presence.state)).toEqual(['thinking', 'working', 'idle'])
  expect((await stores.runs.list()).every((run) => run.status === 'succeeded')).toBe(true)
})

it('有人工待办时灯为 waiting；失败回合也会退出 thinking', async () => {
  const { options, stores, requirement, message } = await setup([
    { reply: '需要确认', actions: [{ type: 'request_human', to: 'alice', ask: '选哪一项？', form: 'choice', choices: ['A', 'B'] }] },
    { invalid: true },
  ])
  const onPresence = vi.fn()
  const lead = createLeadRuntime({ ...options, onPresence })
  await lead.onMessage(requirement.id, await message())
  expect(lead.getPresence(requirement.id).state).toBe('waiting')
  await expect(lead.onMessage(requirement.id, await message())).rejects.toThrow('Lead 回合失败')
  expect(lead.getPresence(requirement.id).state).toBe('waiting')
  const item = (await stores.attention.list({ pending: true }))[0]!
  const answered = await stores.attention.answer(item.requestId, { decision: 'choice', answer: 'A', by: { type: 'human', id: 'alice' } })
  await lead.onAttention(answered)
  expect(lead.getPresence(requirement.id).state).toBe('idle')
})

it('新增关键事件播报，忽略逐节点启动和普通日志，跨回放去重', async () => {
  const { stores, lead, requirement } = await setup([])
  const run = await createEngine({ stores, profiles: {}, harnesses: {}, knowledge: [] }).start({ requirementId: requirement.id, workflow: { id: 'events', title: '事件', version: '1', stages: [], nodes: [] } })
  const actor = { type: 'system', id: 'test' } as const
  const usage = { budget: { tokens: 100 }, used: { tokens: 80, minutes: 1 }, ratio: 0.8 }
  const events = [
    await stores.events.append(run.runId, { type: 'budget.warning', actor, data: usage }),
    await stores.events.append(run.runId, { type: 'budget.exhausted', actor, data: { ...usage, ratio: 1 } }),
    await stores.events.append(run.runId, { type: 'retry.suppressed', actor, nodeId: 'work', data: { fingerprint: 'f', code: 'error', count: 2, reason: '重复' } }),
    await stores.events.append(run.runId, { type: 'review.exhausted', actor, nodeId: 'review', data: { rounds: 2, action: 'human' } }),
    await stores.events.append(run.runId, { type: 'route.decided', actor, data: { tier: 'T1', workflowId: 'quick-fix', reason: '单面', surfaces: [], gates: [], roles: [], decidedBy: actor, at: new Date().toISOString() } }),
    await stores.events.append(run.runId, { type: 'node.started', actor, nodeId: 'work', data: { attempt: 1 } }),
    await stores.events.append(run.runId, { type: 'log', actor, data: { level: 'info', message: '过程' } }),
  ]
  for (const event of events) { await lead.onRunEvent(run.runId, event); await lead.onRunEvent(run.runId, event) }
  const messages = (await stores.chat.list(requirement.id)).filter((message) => message.kind === 'progress')
  expect(messages).toHaveLength(5)
  expect(messages.map((message) => message.text).join('\n')).toContain('相同失败停止重试')
})

it('completion 透传，impact 保留在 TaskSpec，不额外改变角色权限', async () => {
  const { stores, profiles } = await setup([])
  const generated = taskWorkflow(task({ completion: ['所有验收标准有测试证据'], impact: 'cosmetic', review: false }), stores, profiles)
  expect(generated.workflow.nodes[0]).toMatchObject({ completion: ['所有验收标准有测试证据'], role: 'pm' })
})

it.each(['semantic', 'cosmetic'] as const)('任务改写已有产物透传 %s，仅语义变更传播 stale，重复收尾幂等', async (impact) => {
  const { stores, requirement, lead, send } = await setup([{ reply: '修改', actions: [{ type: 'dispatch_task', task: task({ impact, review: false }) }] }], {
    task: async (request) => { await writeFile(join(request.env!.TAKT_WORKSPACE!, 'spec/prd.md'), '新的描述') },
  })
  await stores.workspaces.writeArtifact({ ref: { workspace: requirement.id, path: 'spec/prd.md' }, kind: 'spec', content: '旧描述', author: { type: 'human', id: 'alice' }, reason: '初版' })
  const main = await createEngine({ stores, profiles: {}, harnesses: {}, knowledge: [] }).start({ requirementId: requirement.id, workflow: { id: 'main', title: '主流程', version: '1', stages: [], nodes: [
    { id: 'consume', kind: 'script', title: '使用 PRD', inputs: [{ path: 'spec/prd.md' }], run: async () => {} },
  ] } })
  const result = (await send())!
  await lead.drain()
  const taskRun = (await stores.runs.get(result.results[0]!.refs!.taskRunId!))!
  expect(taskRun.status).toBe('succeeded')
  expect((await stores.runs.get(main.runId))!.nodes.consume!.status).toBe(impact === 'semantic' ? 'stale' : 'succeeded')
  expect((await stores.events.read(main.runId, { types: ['artifact.edited'] })).at(-1)?.data).toMatchObject({ impact })
  const before = await stores.events.read(taskRun.runId, { types: ['artifact.edited'] })
  expect(before).toHaveLength(1)
  await recordTaskImpact(stores, taskRun)
  expect(await stores.events.read(taskRun.runId, { types: ['artifact.edited'] })).toEqual(before)
})

// auto 路由单测独立于 FsEventStore 的 M3 白名单接入；本替身不冒充持久化或哈希校验。
function memoryEvents(): EventStore {
  const events = new Map<string, EventEnvelope[]>()
  const listeners = new Map<string, Set<(event: EventEnvelope) => void>>()
  return {
    async append<T extends EventType>(runId: string, input: Parameters<EventStore['append']>[1]) {
      const previous = events.get(runId) ?? []
      const event = { ...input, runId, ts: new Date().toISOString(), seq: previous.length + 1, prevHash: '', hash: '' } as EventEnvelope<T>
      events.set(runId, [...previous, event])
      for (const listener of listeners.get(runId) ?? []) listener(event)
      return event
    },
    async read(runId, options = {}) { return (events.get(runId) ?? []).filter((event) => (!options.afterSeq || event.seq > options.afterSeq) && (!options.nodeId || event.nodeId === options.nodeId) && (!options.types || options.types.includes(event.type))) },
    subscribe(runId, listener) {
      const subscribers = listeners.get(runId) ?? new Set()
      subscribers.add(listener); listeners.set(runId, subscribers)
      return () => { subscribers.delete(listener) }
    },
    async verify() { throw new Error('内存替身不提供持久化校验') },
  }
}

it('M5：任务回执 sent → started → done，来源人类为零跳', async () => {
  const { send, lead, stores, requirement } = await setup([{ reply: '派发', actions: [{ type: 'dispatch_task', task: task({ inputs: [], outputs: [], review: false }) }] }])
  const turn = await send(); await lead.drain()
  const runId = turn!.results[0]!.refs!.taskRunId!
  expect((await stores.runs.get(runId))!.origin).toMatchObject({ hops: 0, chain: [] })
  expect((await stores.chat.list(requirement.id)).filter(message => message.refs?.taskRunId === runId).map(message => message.receipt?.status)).toEqual(['sent', 'started', 'done'])
})
it('M5：上游 agent 派活增加跳数，超限拒绝且留下链路回执', async () => {
  const { stores, requirement, lead, send } = await setup([{ reply: '派发', actions: [{ type: 'dispatch_task', task: task({ inputs: [], outputs: [], review: false }) }] }])
  const initial = await send(); await lead.drain()
  const parentId = initial!.results[0]!.refs!.taskRunId!
  const message = await stores.chat.post(requirement.id, { author: { type: 'agent', role: 'pm', harness: 'mock' }, kind: 'text', text: '@lead 继续', refs: { taskRunId: parentId } })
  stores.config.lead!.maxHops = 0
  const denied = await lead.executeAction({ type: 'dispatch_task', task: task({ inputs: [], outputs: [], review: false }) }, requirement.id, message, undefined, 0)
  expect(denied.ok).toBe(false)
  expect(denied.message).toContain(parentId)
  expect((await stores.chat.list(requirement.id)).find(item => item.receipt?.status === 'refused')!.receipt).toMatchObject({ hops: 1, chain: [parentId] })
  stores.config.lead!.maxHops = 1
  const allowed = await lead.executeAction({ type: 'dispatch_task', task: task({ inputs: [], outputs: [], review: false }) }, requirement.id, message, undefined, 0)
  await lead.drain()
  expect(allowed.ok).toBe(true)
  expect((await stores.runs.get(allowed.refs!.taskRunId!))!.origin).toMatchObject({ hops: 1, chain: [parentId] })
})


it.each(['dead', 'missing', 'live'] as const)('run.resume 命令区分中断与活租约（%s）', async owner => {
  const next = vi.fn(async () => {})
  const workflow: WorkflowDefinition = { id: 'resume-crash', title: '恢复', version: '1', stages: [], nodes: [
    { id: 'first', title: '已完成', kind: 'script', run: async () => { throw new Error('不应重跑') } },
    { id: 'next', title: '下一步', kind: 'script', needs: ['first'], run: next },
  ] }
  const runId = 'crashed'
  const { stores, requirement, send, lead } = await setup([{ reply: '恢复运行', actions: [{ type: 'resume_run', runId }] }], {
    workflows: { load: async () => workflow, get: async () => ({ rev: '1', source: '' }), replaceSource: async () => {} },
  })
  await stores.runs.create({ runId, workflowId: workflow.id, workflowVersion: workflow.version, requirementId: requirement.id,
    status: 'running', startedAt: new Date().toISOString(), args: {}, expansions: [], nodes: {
      first: { id: 'first', status: 'succeeded', attempts: 1, outputs: [] }, next: { id: 'next', status: 'running', attempts: 1, outputs: [] },
    } }, snapshotWorkflow(workflow))
  if (owner !== 'missing') {
    const { stdout } = await promisify(execFile)(process.execPath, ['-e', 'console.log(process.pid)'])
    await writeFile(join(stores.taktDir, 'runs', runId, 'lease.json'), JSON.stringify({ pid: owner === 'live' ? process.pid : Number(stdout.trim()), host: hostname(), startedAt: new Date().toISOString() }))
  }
  const turn = (await send())!
  await lead.drain()
  expect(turn.results[0]).toMatchObject({ ok: owner !== 'live', ...(owner === 'live' ? { message: '运行仍在执行' } : {}) })
  expect(next).toHaveBeenCalledTimes(owner === 'live' ? 0 : 1)
  expect((await stores.runs.get(runId))!.status).toBe(owner === 'live' ? 'running' : 'succeeded')
  const commands = (await stores.events.read(turn.run.runId)).filter(event => event.type === 'log').map(event => JSON.stringify(event.data))
  expect(commands.some(text => text.includes('run.resume'))).toBe(true)
})

it('启动异常后移除本进程引擎记录，中断运行仍能继续', async () => {
  const next = vi.fn(async () => {})
  const workflow: WorkflowDefinition = { id: 'resume-error', title: '恢复', version: '1', stages: [], nodes: [{ id: 'next', title: '下一步', kind: 'script', run: next }] }
  const { stores, requirement, lead, message } = await setup([], { workflows: {
    load: async () => workflow, get: async () => ({ rev: '1', source: '' }), replaceSource: async () => {},
  } })
  const append = stores.events.append.bind(stores.events)
  const injected = vi.spyOn(stores.events, 'append').mockImplementation(async (runId, input) => {
    if (input.type === 'run.started') throw new Error('模拟初始化异常')
    return append(runId, input)
  })
  const trigger = await message()
  const started = await lead.executeAction({ type: 'start_run', workflowId: workflow.id }, requirement.id, trigger, undefined, 0)
  await lead.drain()
  injected.mockRestore()
  const runId = started.refs!.runId!
  expect((await stores.runs.get(runId))!.status).toBe('running')
  expect(await lead.executeAction({ type: 'resume_run', runId }, requirement.id, trigger, undefined, 0)).toMatchObject({ ok: true })
  await lead.drain()
  expect(next).toHaveBeenCalledTimes(1)
})

it('Lead retry_run 通过 write 命令审计后重试失败运行，事件归属发起人', async () => {
  const workflow: WorkflowDefinition = { id: 'retry', title: '重试', version: '1', stages: [], nodes: [{ id: 'work', kind: 'agent', title: '执行', role: 'pm', prompt: '执行' }] }
  const turns: LeadTurn[] = [{ reply: '启动', actions: [{ type: 'start_run', workflowId: workflow.id }] }]
  let calls = 0
  const { stores, lead, send } = await setup(turns, {
    task: async () => { if (++calls === 1) throw new Error('首次执行失败') },
    workflows: { load: async () => workflow, get: async () => ({ source: '', rev: 'base' }), replaceSource: async () => undefined },
  })
  const started = (await send())!.results[0]!
  await lead.drain()
  const runId = started.refs!.runId!
  expect((await stores.runs.get(runId))!.status).toBe('failed')
  turns.push({ reply: '重试失败节点', actions: [{ type: 'retry_run', runId, nodeIds: ['work'] }] })
  const turn = (await send())!
  expect(turn.results[0]).toMatchObject({ action: 'retry_run', ok: true })
  await lead.drain()
  expect((await stores.runs.get(runId))!.status).toBe('succeeded')
  expect(calls).toBe(2)
  expect(await stores.events.read(runId, { types: ['run.retried'] })).toMatchObject([{ actor: { type: 'human', id: 'alice' }, data: { nodeIds: ['work'], reason: expect.stringContaining('Lead 响应消息') } }])
  const logs = await stores.events.read(turn.run.runId, { types: ['log'] })
  expect(logs.some(event => JSON.stringify(event.data).includes('run.retry'))).toBe(true)
})
