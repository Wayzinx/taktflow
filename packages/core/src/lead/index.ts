import { withSpaceLease } from '../store/lease-scope.js'
import { assertAnswerFreshness } from '../store/attention-freshness.js'
import type { AttentionItem, Engine } from '../interfaces.js'
import type { Actor, AgentProfile, EventEnvelope, LeadActionResult, LeadTurn, RoomMessage, RunState, WorkflowDefinition } from '../types.js'
import { stageProgress } from '../insights/graph.js'
import { sha256 } from '../util/hash.js'
import { readJsonFile, writeFileAtomic } from '../store/fs-utils.js'
import { withFileLock } from '../store/file-lock.js'
import { join } from 'node:path'
import { createLeadEngine } from './engine.js'
import { leadContext } from './context.js'
import { LEAD_TURN_SCHEMA, validateAction } from './schema.js'
import { taskWorkflow } from './task.js'
import { errorText, type LeadRuntimeOptions, type LeadTurnResult, type TaskRunState } from './contracts.js'

export type { LeadRuntimeOptions, LeadTurnResult, TaskRunState, LeadWorkflowAccess } from './contracts.js'
export { taskWorkflow } from './task.js'

interface Proposal { requestId: string; workflowId: string; description: string; baseRev: string; source?: string }
const system: Actor = { type: 'system', id: 'lead' }
const finished = (state: RunState) => ['succeeded', 'failed', 'cancelled'].includes(state.status)

export function createLeadRuntime(options: LeadRuntimeOptions) {
  const { stores } = options
  const selector = stores.config.lead?.harness ?? options.profiles.lead?.harness ?? stores.config.roles?.lead ?? { harness: 'mock' }
  const author: Actor = { type: 'agent', role: 'lead', harness: selector.harness, model: selector.model }
  const profiles: Record<string, AgentProfile> = { ...options.profiles, lead: { ...options.profiles.lead, role: 'lead', title: 'Lead', description: options.profiles.lead?.description ?? '需求协调与任务派发',
    harness: selector, skills: [], instructions: options.instructions ?? options.profiles.lead?.instructions ?? '你是需求群的 Lead，负责回答状态和派发任务。只输出 LeadTurn，不直接写文件、不替人审批。',
    writeScope: [], allowBash: false } satisfies AgentProfile }
  const queues = new Map<string, Promise<unknown>>()
  const jobs = new Set<Promise<unknown>>()
  const engines = new Map<string, Engine>()
  const post = (id: string, message: Omit<RoomMessage, 'id' | 'seq' | 'roomId' | 'at'>) => stores.chat.post(id, message)
  const audit = (runId: string, message: unknown) => stores.events.append(runId, { type: 'log', actor: author, data: { level: 'info', message: JSON.stringify(message) } })
  const cancelAll = async () => { await Promise.all([...engines].map(([id, engine]) => engine.cancel(id))) }
  const withWriteLease: NonNullable<LeadRuntimeOptions['withWriteLease']> = options.withWriteLease ??
    ((stores, fn) => withSpaceLease(stores.taktDir, `lead:${process.pid}`, fn, { onRenewError: cancelAll }))
  const scopedEngine = createLeadEngine({ ...options, withWriteLease }, profiles, onRunEvent, audit)
  const serial = <T>(id: string, fn: () => Promise<T>): Promise<T> => {
    const next = (queues.get(id) ?? Promise.resolve()).catch(() => undefined).then(fn)
    queues.set(id, next)
    void next.finally(() => { if (queues.get(id) === next) queues.delete(id) }).catch(() => undefined)
    return next
  }

  async function onRunEvent(runId: string, event: EventEnvelope): Promise<void> {
    if (!['node.started', 'node.finished', 'node.failed', 'run.finished', 'human.requested', 'review.round', 'rework.started'].includes(event.type)) return
    const file = join(stores.taktDir, 'runs', runId, 'lead-projection.json')
    await withFileLock(file, async () => {
      const projection = await readJsonFile<{ events: number[]; stages: string[] }>(file) ?? { events: [], stages: [] }
      if (projection.events.includes(event.seq)) return
      const state = await stores.runs.get(runId) as TaskRunState | undefined
      if (!state || state.workflowId === 'lead') return
      if (event.type === 'run.finished') engines.delete(runId)
      const refs = { runId, nodeId: event.nodeId }
      if (state.kind === 'task' && ['node.started', 'node.finished', 'node.failed', 'run.finished', 'human.requested', 'review.round'].includes(event.type)) {
        const node = event.nodeId && state.nodes[event.nodeId]
        await post(state.requirementId, { author, kind: 'task', text: `${state.origin?.title ?? state.workflowId}：${state.status}${node ? `；${node.id} ${node.status}` : ''}`,
          replyTo: state.origin?.messageId, refs: { ...refs, taskRunId: runId, artifacts: Object.values(state.nodes).flatMap((node) => node.outputs) } })
      }
      if (stores.config.lead?.progressUpdates !== true) {
        projection.events.push(event.seq)
        await writeFileAtomic(file, JSON.stringify(projection))
        return
      }
      let text: string | undefined
      if (event.type === 'run.finished') text = `运行结束：${(event.data as { status: string }).status}`
      else if (event.type === 'human.requested') { const data = event.data as { ask: string; requestId: string }; text = `需要人工处理：${data.ask}` }
      else if (event.type === 'review.round') { const data = event.data as { round: number; passed: boolean }; text = `评审 ${event.nodeId} 第 ${data.round} 轮${data.passed ? '通过' : '未通过'}` }
      else if (event.type === 'rework.started') { const data = event.data as { from: string; to: string; feedback: string }; text = `已打回重做：${data.from} → ${data.to}。${data.feedback}` }
      else if (event.type === 'node.finished') {
        const snapshot = await stores.runs.getWorkflow(runId)
        if (snapshot) for (const stage of stageProgress(snapshot, state).filter((stage) => stage.status === 'done')) {
          if (projection.stages.includes(stage.id)) continue
          projection.stages.push(stage.id)
          await post(state.requirementId, { author, kind: 'progress', text: `阶段完成：${stage.title}`, refs })
        }
      }
      if (text) await post(state.requirementId, { author, kind: 'progress', text, refs: { ...refs,
        ...(event.type === 'human.requested' ? { requestId: (event.data as { requestId: string }).requestId } : {}) } })
      projection.events.push(event.seq)
      await writeFileAtomic(file, JSON.stringify(projection))
    })
  }

  function instrument(message: RoomMessage, title: string, scopedProfiles: Record<string, AgentProfile>, created: (state: TaskRunState) => Promise<void>, kind: 'task' | 'workflow' = 'task') {
    return scopedEngine({ message, title, profiles: scopedProfiles, created, kind })
  }

  async function launch(workflow: WorkflowDefinition, requirementId: string, message: RoomMessage, scopedProfiles = profiles, args: Record<string, unknown> = {}, parentRunId?: string): Promise<string> {
    let resolveCreated!: (id: string) => void
    let rejectCreated!: (error: unknown) => void
    const ready = new Promise<string>((resolve, reject) => { resolveCreated = resolve; rejectCreated = reject })
    const engine = instrument(message, workflow.title, scopedProfiles, async (state) => {
      engines.set(state.runId, engine)
      if (parentRunId && workflow.id.startsWith('task:')) await stores.events.append(parentRunId, { type: 'task.dispatched', actor: author,
        data: { taskRunId: state.runId, role: workflow.nodes[0]?.kind === 'agent' ? workflow.nodes[0].role : workflow.id, title: workflow.title, by: message.author } })
      if (workflow.id.startsWith('task:')) await post(requirementId, { author, kind: 'task', text: `${workflow.title}：已派发`, replyTo: message.id, refs: { taskRunId: state.runId, runId: state.runId } })
      resolveCreated(state.runId)
    }, workflow.id.startsWith('task:') ? 'task' : 'workflow')
    const job = engine.start({ workflow, requirementId, args }).catch(async (error: unknown) => {
      rejectCreated(error)
      await post(requirementId, { author: system, kind: 'system', text: `运行失败：${errorText(error)}`, replyTo: message.id })
    }).finally(() => { jobs.delete(job) })
    jobs.add(job)
    void job.catch(() => undefined)
    return ready
  }

  async function action(value: unknown, requirementId: string, message: RoomMessage, runId: string, index: number): Promise<LeadActionResult> {
    let actionName = (value && typeof value === 'object' && 'type' in value ? value.type : 'unknown') as LeadActionResult['action']
    try {
      validateAction(value)
      actionName = value.type
      await audit(runId, { kind: 'lead.action', action: value, onBehalfOf: message.author })
      switch (value.type) {
        case 'reply':
          await post(requirementId, { author, kind: 'text', text: value.text, mentions: value.mentions, replyTo: message.id })
          break
        case 'dispatch_task': {
          const task = taskWorkflow(value.task, stores, profiles)
          await stores.chat.addMembers(requirementId, [{ id: `agent:${value.task.role}`, kind: 'agent', name: value.task.role, role: value.task.role }])
          const taskRunId = await launch(task.workflow, requirementId, message, task.profiles, { __leadTask: value.task }, runId)
          return { action: actionName, ok: true, message: `任务已派发：${value.task.title}`, refs: { taskRunId, runId: taskRunId } }
        }
        case 'start_run': {
          if (!options.workflows) throw new Error('未接入 workflow 加载器')
          const workflow = await options.workflows.load(value.workflowId)
          const id = await launch(workflow, requirementId, message, profiles, value.args, runId)
          return { action: actionName, ok: true, message: '运行已启动', refs: { runId: id } }
        }
        case 'resume_run': {
          const state = await requireRun(value.runId, requirementId)
          if (finished(state)) throw new Error('已终结运行不能继续')
          if (state.status === 'running') throw new Error('运行仍在执行')
          if (state.workflowId.startsWith('task:')) { await resumeTask(state.runId); break }
          const engine = engines.get(value.runId)
          if (!options.workflows) throw new Error('未接入 workflow 加载器')
          const workflow = await options.workflows.load(state.workflowId)
          await (engine ?? instrument(message, workflow.title, profiles, async () => {})).resume(state.runId, workflow)
          break
        }
        case 'cancel_run': {
          await requireRun(value.runId, requirementId)
          const member = message.author.type === 'human' && stores.config.members?.find((member) => member.id === (message.author as { id: string }).id)
          if (!member || !['owner', 'maintainer'].includes(member.role)) throw new Error('取消运行需要 maintainer 或 owner 发起')
          if (!value.reason.trim()) throw new Error('取消运行必须说明原因')
          await (engines.get(value.runId) ?? options.engineFactory({ stores, profiles, harnesses: options.harnesses })).cancel(value.runId)
          break
        }
        case 'request_human': {
          const room = await stores.chat.getRoom(requirementId)
          if (!value.ask.trim() || !room?.members.some((member) => member.id === value.to && member.kind === 'human') && !stores.config.members?.some((member) => member.id === value.to)) throw new Error('待办接收人必须存在且问题不能为空')
          if (value.form === 'choice' && (!value.choices?.length || new Set(value.choices).size !== value.choices.length)) throw new Error('choice 待办必须有不重复的 choices')
          return await request(runId, index, requirementId, value.ask, value.form, value.to, value.choices)
        }
        case 'propose_workflow_change': {
          if (!options.workflows) throw new Error('未接入 workflow-source store')
          if (!value.description.trim()) throw new Error('修改提案必须有 description')
          const document = await options.workflows.get(value.workflowId)
          await audit(runId, { kind: 'workflow.proposal', proposal: { ...value, baseRev: document.rev, requestId: `${runId}:lead-action-${index}` } })
          return await request(runId, index, requirementId, `workflow 修改：${value.description}`, 'approve')
        }
        case 'update_notes': {
          const ref = await stores.workspaces.writeArtifact({ ref: { workspace: requirementId, path: 'lead-notes.md' }, content: value.content,
            kind: 'other', author, producedBy: { runId, nodeId: 'lead' }, reason: `Lead 备忘；onBehalfOf ${JSON.stringify(message.author)}` })
          await stores.events.append(runId, { type: 'artifact.written', actor: author, nodeId: 'lead', data: { ref, kind: 'other', sha256: sha256(value.content) } })
          return { action: actionName, ok: true, message: 'Lead 备忘已更新', refs: { artifacts: [ref] } }
        }
      }
      return { action: actionName, ok: true, message: '动作已执行' }
    } catch (error) { return { action: actionName, ok: false, message: errorText(error) } }
  }

  async function requireRun(runId: string, requirementId: string) {
    const state = await stores.runs.get(runId)
    if (!state || state.requirementId !== requirementId) throw new Error('运行不存在或属于其他需求')
    return state
  }
  async function request(runId: string, index: number, requirementId: string, ask: string, form: AttentionItem['form'], to?: string, choices?: string[]): Promise<LeadActionResult> {
    const node = (await stores.runs.get(runId))!.nodes.lead!
    const item = await stores.attention.create({ requestId: `${runId}:lead-action-${index}`, runId, nodeId: 'lead', requirementId, ask, form, choices, attempt: node.attempts, subjects: (node.inputs ?? []).map((ref) => ({ ...ref })) })
    await stores.events.append(runId, { type: 'human.requested', actor: author, nodeId: 'lead', data: { requestId: item.requestId, ask, form, choices } })
    await post(requirementId, { author, kind: 'attention', text: ask, mentions: to ? [to] : undefined, refs: { requestId: item.requestId, runId } })
    return { action: 'request_human', ok: true, message: ask, refs: { requestId: item.requestId, runId } }
  }

  async function turn(requirementId: string, message: RoomMessage): Promise<LeadTurnResult> {
    const prompt = await leadContext(stores, requirementId, message)
    const workflow: WorkflowDefinition = { id: 'lead', title: 'Lead 回合', version: '1', stages: [], nodes: [{
      id: 'lead', kind: 'agent', title: 'Lead 回合', role: 'lead', harness: selector, prompt, resultSchema: LEAD_TURN_SCHEMA, writeScope: [], session: 'fresh',
    }] }
    const engine = instrument(message, 'Lead 回合', profiles, async (state) => { engines.set(state.runId, engine) })
    const state = await engine.start({ workflow, requirementId }) as TaskRunState
    engines.delete(state.runId)
    if (state.status !== 'succeeded') {
      await post(requirementId, { author: system, kind: 'system', replyTo: message.id, refs: { runId: state.runId }, text: `Lead 回合失败：${state.nodes.lead?.error ?? state.status}` })
      throw new Error(`Lead 回合失败：${state.nodes.lead?.error ?? state.status}`)
    }
    const result = state.nodes.lead!.result as LeadTurn
    await post(requirementId, { author, kind: 'text', text: result.reply, replyTo: message.id, refs: { runId: state.runId } })
    const results: LeadActionResult[] = []
    for (const [index, value] of result.actions.entries()) {
      const executed = await action(value, requirementId, message, state.runId, index)
      if (value.type === 'propose_workflow_change') executed.action = value.type
      results.push(executed)
      await audit(state.runId, { kind: 'lead.action-result', result: executed, onBehalfOf: message.author })
      await post(requirementId, { author: system, kind: 'system', text: `${executed.action}：${executed.ok ? '成功' : '失败'}；${executed.message}`, replyTo: message.id, refs: executed.refs })
    }
    return { run: state, results }
  }

  async function resumeTask(runId: string): Promise<RunState> {
    const state = await stores.runs.get(runId) as TaskRunState | undefined
    if (!state || !state.workflowId.startsWith('task:') || !state.origin || !state.args.__leadTask) throw new Error('缺少临时任务定义或来源')
    if (finished(state)) return state
    const trigger = (await stores.chat.list(state.requirementId)).find((message) => message.id === state.origin!.messageId)
    if (!trigger) throw new Error('任务触发消息不存在')
    const task = taskWorkflow(state.args.__leadTask as import('../types.js').TaskSpec, stores, profiles)
    const engine = engines.get(runId) ?? instrument(trigger, task.workflow.title, task.profiles, async () => {})
    engines.set(runId, engine)
    return engine.resume(runId, task.workflow)
  }

  async function onAttention(input: AttentionItem): Promise<boolean> {
    const state = await stores.runs.get(input.runId)
    if (state?.workflowId.startsWith('task:')) { await resumeTask(state.runId); return true }
    if (state?.workflowId !== 'lead') return false
    return serial(state.requirementId, () => withFileLock(join(stores.taktDir, 'runs', input.runId, 'lead-approval'), async () => {
      const item = (await stores.attention.list()).find((item) => item.requestId === input.requestId)
      if (!item?.answeredAt || item.answeredBy?.type !== 'human') throw new Error('必须由人先回答待办')
      await assertAnswerFreshness(stores, item)
      const events = await stores.events.read(item.runId, { types: ['log'] })
      const logs = events.map((event) => { try { return JSON.parse((event.data as { message: string }).message) } catch { return {} } })
      if (logs.some((log) => log.kind === 'lead.approval-result' && log.requestId === item.requestId)) return true
      const proposal = logs.find((log) => log.kind === 'workflow.proposal' && log.proposal.requestId === item.requestId)?.proposal as Proposal | undefined
      await stores.events.append(item.runId, { type: 'human.answered', actor: item.answeredBy, nodeId: 'lead', data: { requestId: item.requestId, decision: item.decision, answer: item.answer } })
      let text = `人工已处理：${item.ask}`
      if (proposal && item.decision === 'approve') {
        const source = proposal.source ?? item.answer
        if (!source?.trim()) throw new Error('提案没有源码，请审批时在 answer 中提供完整 workflow 源码')
        if (!options.workflows) throw new Error('未接入 workflow-source store')
        const result = await options.workflows.replaceSource(proposal.workflowId, { source, baseRev: proposal.baseRev, reason: proposal.description, author, onBehalfOf: item.answeredBy })
        if (result && typeof result === 'object' && 'error' in result) {
          await audit(item.runId, { kind: 'lead.approval-failed', requestId: item.requestId, result, onBehalfOf: item.answeredBy })
          await post(item.requirementId, { author: system, kind: 'system', text: `workflow 修改失败：${JSON.stringify(result)}`, refs: { requestId: item.requestId } })
          throw new Error('workflow 修改冲突或校验失败')
        }
        text = `workflow 修改已应用：${proposal.description}`
      } else if (proposal) text = `workflow 修改已拒绝：${proposal.description}`
      await audit(item.runId, { kind: 'lead.approval-result', requestId: item.requestId, onBehalfOf: item.answeredBy, decision: item.decision })
      await post(item.requirementId, { author, kind: 'system', text, refs: { runId: item.runId, requestId: item.requestId } })
      return true
    }))
  }

  return {
    onMessage(requirementId: string, message: RoomMessage, input: { private?: boolean } = {}): Promise<LeadTurnResult | undefined> {
      if (message.author.type !== 'human' || !(input.private || message.mentions?.includes('lead') || /(^|\s)@lead\b/i.test(message.text))) return Promise.resolve(undefined)
      if (message.roomId !== requirementId) return Promise.reject(new Error('消息不属于当前需求'))
      return withWriteLease(stores, () => serial(requirementId, () => turn(requirementId, message)))
    },
    onRunEvent: (runId: string, event: EventEnvelope) => withWriteLease(stores, () => onRunEvent(runId, event)),
    onAttention: (item: AttentionItem) => withWriteLease(stores, () => onAttention(item)),
    resumeTask: (runId: string) => withWriteLease(stores, () => resumeTask(runId)),
    cancelAll,
    async drain(): Promise<void> {
      while (queues.size || jobs.size) await Promise.all([...queues.values(), ...jobs])
    },
  }
}
