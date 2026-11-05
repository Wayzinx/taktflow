import { acquireLease, readLease, releaseLease } from '../store/lease.js'
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

it('同需求回合串行；私聊可触发；普通消息和 Lead 自己的消息不触发', async () => {
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  let active = 0; let maximum = 0; let count = 0
  const setupResult = await setup([{ reply: '一', actions: [] }, { reply: '二', actions: [] }], {
    lead: async () => { active++; maximum = Math.max(maximum, active); if (++count === 1) await gate; active-- },
  })
  const { lead, requirement, message, stores } = setupResult
  const first = lead.onMessage(requirement.id, await message())
  await vi.waitFor(() => expect(count).toBe(1))
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
  expect(run).toMatchObject({ kind: 'task', workflowId: 'lead', origin: { messageId: trigger.id, by: trigger.author } })
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
  expect(run).toMatchObject({ kind: 'task', workflowId: 'task:pm', status: 'succeeded', origin: { messageId: trigger.id, by: trigger.author } })
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

it('progressUpdates 用模板发送阶段、结束、待办、评审和打回信息，不调用 harness；关闭时不发送', async () => {
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
  expect(progress).toHaveLength(5)
  expect(progress.map((message) => message.text).join('\n')).toContain('阶段完成：研发')
  expect(requests).toEqual([])
  stores.config.lead!.progressUpdates = false
  await lead.onRunEvent(state.runId, await stores.events.append(state.runId, { type: 'run.finished', actor: { type: 'system', id: 'test' }, data: { status: 'succeeded' } }))
  expect((await stores.chat.list(requirement.id)).filter((message) => message.author.type === 'agent')).toHaveLength(5)
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
  const runId = started.refs!.runId!
  expect(await stores.runs.get(runId)).toMatchObject({ workflowId: workflow.id, status: 'waiting_human', kind: 'workflow' })
  turns.push({ reply: '继续', actions: [{ type: 'resume_run', runId }] })
  await send()
  expect((await stores.runs.get(runId))!.status).toBe('waiting_human')
  const item = (await stores.attention.list({ pending: true })).find((item) => item.runId === runId)!
  await stores.attention.answer(item.requestId, { decision: 'approve', by: { type: 'human', id: 'alice' } })
  turns.push({ reply: '继续', actions: [{ type: 'resume_run', runId }] })
  await send()
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
  const item = (await stores.attention.list({ pending: true })).find((item) => item.runId === runId)!
  const answered = await stores.attention.answer(item.requestId, { decision: 'choice', answer: '放行', by: { type: 'human', id: 'alice' } })
  const restarted = createLeadRuntime(options)
  expect(await restarted.onAttention(answered)).toBe(true)
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


it('Lead 在空间被占用时拒绝新回合且不创建运行', async () => {
  const { stores, lead, requirement, message } = await setup([{ reply: '不能执行', actions: [] }])
  const trigger = await message()
  await acquireLease(stores.taktDir, 'dsh:other')
  try {
    await expect(lead.onMessage(requirement.id, trigger)).rejects.toThrow('空间正被 dsh:other')
    expect(await stores.runs.list()).toEqual([])
    expect((await readLease(stores.taktDir))?.owner).toBe('dsh:other')
  } finally { await releaseLease(stores.taktDir, 'dsh:other') }
})

it('Lead 回合返回后，后台任务继续持有租约直到任务收敛', async () => {
  let release!: () => void
  let started!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  const ready = new Promise<void>((resolve) => { started = resolve })
  const { stores, lead, send } = await setup([{ reply: '派发', actions: [{ type: 'dispatch_task', task: task({ inputs: [], outputs: [], writeScope: [], review: false }) }] }], {
    task: async () => { started(); await gate },
  })
  try {
    expect((await send())!.results[0]!.ok).toBe(true); await ready
    expect((await acquireLease(stores.taktDir, 'dsh:other')).ok).toBe(false)
    expect((await readLease(stores.taktDir))?.owner).toBe(`lead:${process.pid}`)
  } finally { release(); await lead.drain() }
  expect(await readLease(stores.taktDir)).toBeUndefined()
})
