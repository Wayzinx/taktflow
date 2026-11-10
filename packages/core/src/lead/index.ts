import { runLiveness } from '../engine/lease.js'
import { resumeInBackground } from '../engine/resume-background.js'
import { reconcileAssumptions } from '../attention/timebox.js'
import { withTaskReceiptLock } from './receipts.js'
import { assertTaskResendable, checkDelegationHops, TaskResendConflictError } from './delegation.js'
import { startRouted } from '../route/start.js'
import type { StartRunInput } from '../interfaces.js'
import type { LeadAction, LeadPresence, RouteDecision } from '../types.js'
import { createCommandRegistry } from '../commands/index.js'
import type { CommandRegistry, CommandSpec } from '../commands/contracts.js'
import { routeRequirement } from '../route/index.js'
import { snapshotWorkflow } from '../store/snapshot.js'
import { actionSchemas } from './schema.js'
import { recordTaskImpact } from './task-impact.js'
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
import { briefError } from '../util/brief.js'

export type { LeadRuntimeOptions, LeadTurnResult, TaskRunState, LeadWorkflowAccess } from './contracts.js'
export { taskWorkflow } from './task.js'
export { assertTaskResendable, TaskResendConflictError } from './delegation.js'
export { DEFAULT_RECEIPT_TIMEOUT_MINUTES, expireTaskReceipts, recoverTaskReceipts } from './receipts.js'

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
  const presence = new Map<string, LeadPresence>()
  const thinking = new Set<string>()
  async function setPresence(id: string, state: LeadPresence['state']) {
    if (presence.get(id)?.state === state) return
    const value = { state, since: new Date().toISOString() }
    presence.set(id, value)
    await options.onPresence?.(id, value)
  }
  async function refreshPresence(id: string) {
    if (thinking.has(id)) return
    const pending = (await stores.attention.list({ requirementId: id, pending: true })).filter(item => item.kind !== 'assumption')
    const runs = await stores.runs.list({ requirementId: id })
    await setPresence(id, pending.length ? 'waiting' : runs.some((run) => run.workflowId !== 'lead' && run.status === 'running') ? 'working' : 'idle')
  }
  const post = (id: string, message: Omit<RoomMessage, 'id' | 'seq' | 'roomId' | 'at'>) => message.kind === 'task'
    ? withTaskReceiptLock(stores, id, () => stores.chat.post(id, message)) : stores.chat.post(id, message)
  const audit = (runId: string, message: unknown) => stores.events.append(runId, { type: 'log', actor: author, data: { level: 'info', message: JSON.stringify(message) } })
  const scopedEngine = createLeadEngine(options, profiles, onRunEvent, audit)
  const serial = <T>(id: string, fn: () => Promise<T>): Promise<T> => {
    const next = (queues.get(id) ?? Promise.resolve()).catch(() => undefined).then(fn)
    queues.set(id, next)
    void next.finally(() => { if (queues.get(id) === next) queues.delete(id) }).catch(() => undefined)
    return next
  }

  async function onRunEvent(runId: string, event: EventEnvelope): Promise<void> {
    if (['node.started', 'node.finished', 'node.failed', 'human.requested', 'human.answered', 'run.finished', 'budget.exhausted', 'retry.suppressed'].includes(event.type)) {
      const observed = await stores.runs.get(runId)
      if (observed && observed.workflowId !== 'lead') await refreshPresence(observed.requirementId)
    }
    if (!['node.started', 'node.finished', 'run.finished', 'human.requested', 'review.exhausted', 'budget.warning', 'budget.exhausted', 'retry.suppressed', 'route.decided'].includes(event.type)) return
    const file = join(stores.taktDir, 'runs', runId, 'lead-projection.json')
    await withFileLock(file, async () => {
      const projection = await readJsonFile<{ events: number[]; stages: string[] }>(file) ?? { events: [], stages: [] }
      if (projection.events.includes(event.seq)) return
      const state = await stores.runs.get(runId) as TaskRunState | undefined
      if (!state || state.workflowId === 'lead') return
      if (event.type === 'run.finished') engines.delete(runId)
      const refs = { runId, nodeId: event.nodeId }
      if (state.kind === 'task' && event.type === 'node.started') {
        if (!projection.stages.includes('__task_started')) {
          await post(state.requirementId, { author, kind: 'task', text: `${state.origin?.title ?? state.workflowId}：已开始`, replyTo: state.origin?.messageId, refs: { taskRunId: runId, runId }, receipt: { status: 'started', hops: state.origin?.hops, chain: state.origin?.chain } })
          projection.stages.push('__task_started')
        }
      }
      if (state.kind === 'task' && event.type === 'run.finished') {
        const node = event.nodeId && state.nodes[event.nodeId]
        await post(state.requirementId, { author, kind: 'task', text: `${state.origin?.title ?? state.workflowId}：${state.status}${node ? `；${node.id} ${node.status}` : ''}`,
          replyTo: state.origin?.messageId, receipt: { status: state.status === 'succeeded' ? 'done' : state.status === 'failed' || state.status === 'cancelled' ? 'refused' : 'started', hops: state.origin?.hops, chain: state.origin?.chain }, refs: { ...refs, taskRunId: runId, artifacts: Object.values(state.nodes).flatMap((node) => node.outputs) } })
      }
      if (stores.config.lead?.progressUpdates !== true) {
        projection.events.push(event.seq)
        await writeFileAtomic(file, JSON.stringify(projection))
        return
      }
      let text: string | undefined
      if (event.type === 'run.finished') text = `运行结束：${(event.data as { status: string }).status}`
      else if (event.type === 'human.requested') { const data = event.data as { ask: string; requestId: string }; text = `需要人工处理：${data.ask}` }
      else if (event.type === 'review.exhausted') text = `评审轮次已耗尽：${event.nodeId}`
      else if (event.type === 'budget.warning') text = '预算用量已达到告警线'
      else if (event.type === 'budget.exhausted') text = '预算已耗尽，需要决策'
      else if (event.type === 'retry.suppressed') text = `相同失败停止重试：${event.nodeId}`
      else if (event.type === 'route.decided') { const route = event.data as RouteDecision; text = `路由已决定：${route.tier} · ${route.workflowId}；${route.reason}` }
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

  function instrument(message: RoomMessage, title: string, scopedProfiles: Record<string, AgentProfile>, created: (state: TaskRunState) => Promise<void>, kind: 'task' | 'workflow' = 'task', origin?: TaskRunState['origin']) {
    return scopedEngine({ message, title, profiles: scopedProfiles, created, kind, origin })
  }

  async function launch(workflow: WorkflowDefinition, requirementId: string, message: RoomMessage, scopedProfiles = profiles, args: Record<string, unknown> = {}, parentRunId?: string, start: Pick<StartRunInput, 'budget' | 'route'> = {}, resend?: { origin: NonNullable<TaskRunState['origin']>; reason: string; resendOf: string }): Promise<{ runId: string; taskMessage?: RoomMessage }> {
    let resolveCreated!: (created: { runId: string; taskMessage?: RoomMessage }) => void
    let rejectCreated!: (error: unknown) => void
    let launchedRunId: string | undefined
    const ready = new Promise<{ runId: string; taskMessage?: RoomMessage }>((resolve, reject) => { resolveCreated = resolve; rejectCreated = reject })
    const engine = instrument(message, workflow.title, scopedProfiles, async (state) => {
      launchedRunId = state.runId
      engines.set(state.runId, engine)
      const taskMessage = workflow.id.startsWith('task:') ? await post(requirementId, { author, kind: 'task', text: `${workflow.title}：已派发`, mentions: resend ? message.mentions : undefined,
        receipt: { status: 'sent', hops: state.origin?.hops, chain: state.origin?.chain, ...(resend ? { note: resend.reason } : {}) }, replyTo: message.id, refs: { taskRunId: state.runId, runId: state.runId } }) : undefined
      if (parentRunId && taskMessage) await stores.events.append(parentRunId, { type: 'task.dispatched', actor: author,
        data: { taskRunId: state.runId, role: workflow.nodes[0]?.kind === 'agent' ? workflow.nodes[0].role : workflow.id, title: workflow.title, by: message.author,
          ...(resend ? { resendOf: resend.resendOf, reason: resend.reason } : {}) } })
      resolveCreated({ runId: state.runId, taskMessage })
    }, workflow.id.startsWith('task:') ? 'task' : 'workflow', resend?.origin)
    const job = engine.start({ workflow, requirementId, args, ...start }).then(async (state) => {
      if (state.kind === 'task') await recordTaskImpact(stores, state)
      await refreshPresence(requirementId)
    }).catch(async (error: unknown) => {
      rejectCreated(error)
      await post(requirementId, { author: system, kind: 'system', text: `运行失败：${errorText(error)}`, replyTo: message.id })
    }).finally(() => { jobs.delete(job); if (launchedRunId) engines.delete(launchedRunId) })
    jobs.add(job)
    void job.catch(() => undefined)
    return ready
  }

  async function executeAction(value: unknown, requirementId: string, message: RoomMessage, runId: string | undefined, index: number, route?: RouteDecision, reason?: string): Promise<LeadActionResult> {
    let actionName = (value && typeof value === 'object' && 'type' in value ? value.type : 'unknown') as LeadActionResult['action']
    try {
      validateAction(value)
      actionName = value.type
      if (!runId && !['start_run', 'resume_run', 'retry_run', 'cancel_run', 'dispatch_task'].includes(value.type)) throw new Error('该动作需要 Lead 回合上下文')
      if (runId) await audit(runId, { kind: 'lead.action', action: value, onBehalfOf: message.author })
      switch (value.type) {
        case 'reply':
          await post(requirementId, { author, kind: 'text', text: value.text, mentions: value.mentions, replyTo: message.id })
          break
        case 'dispatch_task': {
          await checkDelegationHops(stores, message)
          const task = taskWorkflow(value.task, stores, profiles)
          await stores.chat.addMembers(requirementId, [{ id: `agent:${value.task.role}`, kind: 'agent', name: value.task.role, role: value.task.role }])
          const { runId: taskRunId } = await launch(task.workflow, requirementId, message, task.profiles, { __leadTask: value.task }, runId)
          return { action: actionName, ok: true, message: `任务已派发：${value.task.title}`, refs: { taskRunId, runId: taskRunId } }
        }
        case 'start_run': {
          if (!options.workflows) throw new Error('未接入 workflow 加载器')
          const workflow = await options.workflows.load(value.workflowId)
          const revision = options.workflows.get ? (await options.workflows.get(workflow.id)).rev : undefined
          const { runId: id } = await launch(workflow, requirementId, message, profiles, { ...value.args, ...(revision ? { workflowRev: revision } : {}), ...(route ? { tier: route.tier } : {}) }, runId, { budget: value.budget, route })
          return { action: actionName, ok: true, message: '运行已启动', refs: { runId: id } }
        }
        case 'resume_run': {
          const state = await requireRun(value.runId, requirementId)
          if (finished(state)) throw new Error('已终结运行不能继续')
          if ((state.status === 'running' && engines.has(state.runId)) || await runLiveness(stores, state.runId, state) === 'active') throw new Error('运行仍在执行')
          if (state.workflowId.startsWith('task:')) { await resumeTask(state.runId); break }
          const engine = engines.get(value.runId)
          if (!options.workflows) throw new Error('未接入 workflow 加载器')
          const workflow = await options.workflows.load(state.workflowId)
          await resume(state, workflow, engine ?? instrument(message, workflow.title, profiles, async () => {}), message)
          break
        }
        case 'retry_run': {
          const state = await requireRun(value.runId, requirementId)
          const retry = { nodeIds: value.nodeIds, reason: reason ?? message.text }
          if (state.workflowId.startsWith('task:')) { await resumeTask(state.runId, { retry, message }); break }
          if (!options.workflows) throw new Error('未接入 workflow 加载器')
          const workflow = await options.workflows.load(state.workflowId)
          await resume(state, workflow, instrument(message, workflow.title, profiles, async () => {}), message, retry)
          break
        }
        case 'cancel_run': {
          await requireRun(value.runId, requirementId)
          await (engines.get(value.runId) ?? options.engineFactory({ stores, profiles, harnesses: options.harnesses })).cancel(value.runId)
          break
        }
        case 'request_human': {
          const room = await stores.chat.getRoom(requirementId)
          if (!value.ask.trim() || !room?.members.some((member) => member.id === value.to && member.kind === 'human') && !stores.config.members?.some((member) => member.id === value.to)) throw new Error('待办接收人必须存在且问题不能为空')
          if (value.form === 'choice' && (!value.choices?.length || new Set(value.choices).size !== value.choices.length)) throw new Error('choice 待办必须有不重复的 choices')
          return await request(runId!, index, requirementId, value.ask, value.form, value.to, value.choices, value.assumption, value.timebox)
        }
        case 'propose_workflow_change': {
          if (!options.workflows) throw new Error('未接入 workflow-source store')
          if (!value.description.trim()) throw new Error('修改提案必须有 description')
          const document = await options.workflows.get(value.workflowId)
          await audit(runId!, { kind: 'workflow.proposal', proposal: { ...value, baseRev: document.rev, requestId: `${runId}:lead-action-${index}` } })
          return await request(runId!, index, requirementId, `workflow 修改：${value.description}`, 'approve')
        }
        case 'update_notes': {
          const ref = await stores.workspaces.writeArtifact({ ref: { workspace: requirementId, path: 'lead-notes.md' }, content: value.content,
            kind: 'other', author, producedBy: { runId: runId!, nodeId: 'lead' }, reason: `Lead 备忘；onBehalfOf ${JSON.stringify(message.author)}` })
          await stores.events.append(runId!, { type: 'artifact.written', actor: author, nodeId: 'lead', data: { ref, kind: 'other', sha256: sha256(value.content) } })
          return { action: actionName, ok: true, message: 'Lead 备忘已更新', refs: { artifacts: [ref] } }
        }
      }
      return { action: actionName, ok: true, message: '动作已执行' }
    } catch (error) { return { action: actionName, ok: false, message: errorText(error) } }
  }

  async function action(value: unknown, requirementId: string, message: RoomMessage, runId: string, index: number): Promise<LeadActionResult> {
    try {
      validateAction(value)
      let current: LeadAction = value
      let route: RouteDecision | undefined
      const delegate = async (next: LeadAction) => {
        const result = await executeAction(next, requirementId, message, runId, index, route, `Lead 响应消息 ${message.id}：${message.text}`)
        if (!result.ok) throw new Error(result.message)
        return result
      }
      const local = createCommandRegistry({ stores, audit: (entry) => audit(runId, { kind: 'command', ...entry }),
        startRun: (input) => delegate({ type: 'start_run', workflowId: input.workflowId, ...(input.args ? { args: input.args } : {}), ...(input.budget ? { budget: input.budget } : {}) }),
        dispatchTask: (input) => delegate({ type: 'dispatch_task', task: input.task }),
        resumeRun: (input) => delegate({ type: 'resume_run', runId: input.runId }),
        retryRun: (input) => delegate({ type: 'retry_run', ...input }),
        cancelRun: (input, context) => delegate({ type: 'cancel_run', runId: input.runId, reason: context.reason! }),
        route: async (input, context) => {
          if (!options.workflows) throw new Error('未接入 workflow 加载器')
          const workflows = options.workflows.list ? await options.workflows.list() : await Promise.all(stores.config.workflows.map(async (id) => {
            const workflow = await options.workflows!.load(id)
            return { id: workflow.id, snapshot: snapshotWorkflow(workflow) }
          }))
          return (options.route ?? routeRequirement)({ stores, ...input, workflows, model: options.routeModel, by: context.actor })
        },
        extensions: (['reply', 'request_human', 'propose_workflow_change', 'update_notes'] as const).map((type): CommandSpec => ({
          id: `lead.${type}`, title: type, kind: 'command', risk: 'write', minRole: 'member',
          input: { type: 'object', ...actionSchemas[type] }, handler: (input) => delegate({ ...input, type } as LeadAction),
        })),
      })
      const commands = options.commands ?? local
      const context = { actor: message.author, reason: current.type === 'cancel_run' ? current.reason : `Lead 响应消息 ${message.id}：${message.text}` }
      if (current.type === 'command') {
        if (commands.list().find((command) => command.id === (current as Extract<LeadAction, { type: 'command' }>).id)?.risk !== 'read') throw new Error('command 动作只允许 read 命令')
        const input = { ...current.input }
        if (input.requirementId && input.requirementId !== requirementId) throw new Error('命令不能查询其他需求')
        if (input.runId) await requireRun(String(input.runId), requirementId)
        if (['requirement.status', 'attention.list'].includes(current.id)) input.requirementId = requirementId
        const result = await commands.run(current.id, input, { actor: author })
        return { action: current.type, ok: result.ok, message: result.ok ? JSON.stringify(result.result ?? result.message) : result.message }
      }
      if (current.type === 'start_run' && current.workflowId === 'auto') {
        const routed = await startRouted(stores, [], { ...current, requirementId }, author, async () => {
          const result = await commands.run('route.preview', { requirementId, hint: message.text }, context)
          if (!result.ok) throw new Error(result.message)
          return result.result as RouteDecision
        }, message.id)
        route = routed.route
        current = { ...current, workflowId: routed.workflowId, args: routed.args }
      }
      const mapping: Partial<Record<LeadAction['type'], string>> = { start_run: 'run.start', resume_run: 'run.resume', retry_run: 'run.retry', cancel_run: 'run.cancel', dispatch_task: 'task.dispatch' }
      const id = mapping[current.type] ?? `lead.${current.type}`
      if (current.type === 'resume_run' || current.type === 'retry_run' || current.type === 'cancel_run') await requireRun(current.runId, requirementId)
      if (current.type === 'dispatch_task' && options.commands?.list().some(command => command.id === id)) await checkDelegationHops(stores, message)
      const registry: CommandRegistry = commands.list().some((command) => command.id === id) ? commands : local
      const result = await registry.run(id, { ...current, requirementId, ...(route ? { route } : {}) }, context)
      const executed = result.result as LeadActionResult | undefined
      return executed && typeof executed === 'object' && 'action' in executed ? executed
        : { action: current.type, ok: result.ok, message: result.message,
          ...(result.ok && result.result && typeof result.result === 'object' && 'runId' in result.result ? { refs: { runId: String(result.result.runId), ...(current.type === 'dispatch_task' ? { taskRunId: String(result.result.runId) } : {}) } } : {}) }
    } catch (error) {
      return { action: value && typeof value === 'object' && 'type' in value ? value.type as LeadAction['type'] : 'reply', ok: false, message: errorText(error) }
    }
  }

  async function requireRun(runId: string, requirementId: string) {
    const state = await stores.runs.get(runId)
    if (!state || state.requirementId !== requirementId) throw new Error('运行不存在或属于其他需求')
    return state
  }
  async function request(runId: string, index: number, requirementId: string, ask: string, form: AttentionItem['form'], to?: string, choices?: string[], assumption?: string, timebox?: AttentionItem['timebox']): Promise<LeadActionResult> {
    const item = await stores.attention.create({ requestId: `${runId}:lead-action-${index}`, runId, nodeId: 'lead', requirementId, ask, form, choices, assignees: to ? [to] : undefined, timebox: timebox ?? stores.config.human, assumption })
    await stores.events.append(runId, { type: 'human.requested', actor: author, nodeId: 'lead', data: { requestId: item.requestId, ask, form, choices, timebox: item.timebox, assumption } })
    await post(requirementId, { author, kind: 'attention', text: ask, mentions: to ? [to] : undefined, refs: { requestId: item.requestId, runId } })
    return { action: 'request_human', ok: true, message: ask, refs: { requestId: item.requestId, runId } }
  }

  async function turn(requirementId: string, message: RoomMessage): Promise<LeadTurnResult> {
    await post(requirementId, { author, kind: 'system', text: 'Lead 已接手', replyTo: message.id, receipt: { status: 'taken' } })
    const prompt = await leadContext(stores, requirementId, message, { instructions: profiles.lead!.instructions, commands: options.commands?.list() ?? createCommandRegistry({ stores, audit: async () => {} }).list() })
    const workflow: WorkflowDefinition = { id: 'lead', title: 'Lead 回合', version: '1', stages: [], nodes: [{
      id: 'lead', kind: 'agent', title: 'Lead 回合', role: 'lead', harness: selector, prompt, resultSchema: LEAD_TURN_SCHEMA, writeScope: [], session: 'fresh',
    }] }
    const engine = instrument(message, 'Lead 回合', profiles, async (state) => { engines.set(state.runId, engine) })
    const state = await engine.start({ workflow, requirementId }) as TaskRunState
    engines.delete(state.runId)
    if (state.status !== 'succeeded') {
      await post(requirementId, { author: system, kind: 'system', replyTo: message.id, refs: { runId: state.runId }, text: `Lead 回合失败：${briefError(state.nodes.lead?.error ?? state.status)}` })
      throw new Error(`Lead 回合失败：${state.nodes.lead?.error ?? state.status}`)
    }
    const result = state.nodes.lead!.result as LeadTurn
    await post(requirementId, { author, kind: 'text', text: result.reply, receipt: { status: 'replied' }, replyTo: message.id, refs: { runId: state.runId } })
    const results: LeadActionResult[] = []
    for (const [index, value] of result.actions.entries()) {
      const executed = await action(value, requirementId, message, state.runId, index)
      if (value.type === 'propose_workflow_change') executed.action = value.type
      results.push(executed)
      await audit(state.runId, { kind: 'lead.action-result', result: executed, onBehalfOf: message.author })
      if (!executed.ok || value.type === 'command') await post(requirementId, { author: system, kind: 'system', text: `${executed.action}：${executed.ok ? '成功' : '失败'}；${executed.message}`, replyTo: message.id, refs: executed.refs })
    }
    return { run: state, results }
  }

  async function resendTask(requirementId: string, message: RoomMessage, reason: string): Promise<RoomMessage> {
    return serial(requirementId, async () => {
      const messages = await stores.chat.list(requirementId)
      const original = messages.find(entry => entry.id === message.id)
      if (!original || original.roomId !== requirementId) throw new TaskResendConflictError('原任务消息已丢失；请刷新群聊后重新向 @lead 发起任务')
      assertTaskResendable(messages, original)
      if (!reason.trim()) throw new TaskResendConflictError('重发必须填写原因；请补充后重试')
      const state = original.refs?.taskRunId ? await stores.runs.get(original.refs.taskRunId) : undefined
      if (!state || state.requirementId !== requirementId || state.kind !== 'task' || !state.origin || !state.args.__leadTask) {
        throw new TaskResendConflictError('原任务运行或任务定义已丢失，无法重发；请在群聊向 @lead 重新描述任务并派发')
      }
      let task: ReturnType<typeof taskWorkflow>
      try { task = taskWorkflow(state.args.__leadTask as import('../types.js').TaskSpec, stores, profiles) }
      catch (error) { throw new TaskResendConflictError(`原任务无法恢复：${errorText(error)}；请恢复角色与任务配置，或向 @lead 重新发起任务`) }
      if (task.workflow.id !== state.workflowId) throw new TaskResendConflictError('原任务定义与 workflow 不一致；请核对运行记录后向 @lead 重新发起任务')
      let parentRunId: string | undefined
      for (const candidate of await stores.runs.list({ requirementId })) {
        if (candidate.workflowId !== 'lead') continue
        const events = await stores.events.read(candidate.runId, { types: ['task.dispatched'] })
        if (events.some(event => (event.data as import('../types.js').EventPayloads['task.dispatched']).taskRunId === state.runId)) {
          parentRunId = candidate.runId
          break
        }
      }
      // 重发是同一份工作的新尝试，不是下游派活；不能重新计算 hops 或向 chain 追加原运行。
      const result = await launch(task.workflow, requirementId, original, task.profiles, structuredClone(state.args), parentRunId,
        { budget: state.budget, route: state.route }, { origin: { ...structuredClone(state.origin), messageId: original.id }, reason, resendOf: state.runId })
      return result.taskMessage!
    })
  }

  async function resume(state: RunState, workflow: WorkflowDefinition, engine: Engine, message: RoomMessage, retry?: { nodeIds?: string[]; reason?: string }): Promise<void> {
    let started = false
    const report = async (error: unknown) => {
      await post(state.requirementId, { author: system, kind: 'system', text: `运行失败：${errorText(error)}`, replyTo: message.id, refs: { runId: state.runId } })
    }
    await resumeInBackground(onStarted => {
      const opts = { ...retry, onStarted: () => {
        started = true
        engines.set(state.runId, engine)
        onStarted()
      } }
      return retry ? engine.retry(state.runId, workflow, opts) : engine.resume(state.runId, workflow, opts)
    }, {
      jobs, onError: report,
      onSettled: async result => {
        try {
          // 节点异常会被引擎收敛为 failed 状态，不一定表现为 Promise rejection。
          if (result?.status === 'failed') await report(Object.values(result.nodes).find(node => node.error)?.error ?? '节点执行失败')
          if (result?.kind === 'task') await recordTaskImpact(stores, result)
        } finally {
          if (started && engines.get(state.runId) === engine) engines.delete(state.runId)
          await refreshPresence(state.requirementId)
        }
      },
    })
  }

  async function resumeTask(runId: string, options: { foreground?: boolean; retry?: { nodeIds?: string[]; reason?: string }; message?: RoomMessage } = {}): Promise<RunState> {
    const state = await stores.runs.get(runId) as TaskRunState | undefined
    if (!state || !state.workflowId.startsWith('task:') || !state.origin || !state.args.__leadTask) throw new Error('缺少临时任务定义或来源')
    if (finished(state) && !options.retry) return state
    const trigger = options.message ?? (await stores.chat.list(state.requirementId)).find((message) => message.id === state.origin!.messageId)
    if (!trigger) throw new Error('任务触发消息不存在')
    const task = taskWorkflow(state.args.__leadTask as import('../types.js').TaskSpec, stores, profiles)
    const engine = (options.retry ? undefined : engines.get(runId)) ?? instrument(trigger, task.workflow.title, task.profiles, async () => {})
    // CLI 前台调用保留完整结果和异常；网页入口只等待启动回执。
    if (options.foreground) {
      try {
        const result = await (options.retry ? engine.retry(runId, task.workflow, options.retry) : engine.resume(runId, task.workflow))
        await recordTaskImpact(stores, result)
        return result
      } finally { await refreshPresence(state.requirementId) }
    }
    await resume(state, task.workflow, engine, trigger, options.retry)
    return (await stores.runs.get(runId))!
  }

  async function onAttention(input: AttentionItem): Promise<boolean> {
    if (input.kind === 'assumption') { await reconcileAssumptions(stores); return true }
    const state = await stores.runs.get(input.runId)
    if (state?.workflowId.startsWith('task:')) { await resumeTask(state.runId); return true }
    // 运行还在本进程跑（别的分支没完）：回答直接送进调度，不走 resume（那会因"运行仍在执行"失败，回答落了盘却没人接）
    if (state && state.workflowId !== 'lead' && engines.get(input.runId)?.notifyAnswered?.(input.runId)) return true
    if (state?.workflowId !== 'lead') return false
    return serial(state.requirementId, () => withFileLock(join(stores.taktDir, 'runs', input.runId, 'lead-approval'), async () => {
      const item = (await stores.attention.list()).find((item) => item.requestId === input.requestId)
      if (!item?.answeredAt || (item.answeredBy?.type !== 'human' && !(item.form === 'answer' && item.handedBack && item.answeredBy?.type === 'system'))) throw new Error('必须由人先回答待办')
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
    executeAction, resendTask,
    onMessage(requirementId: string, message: RoomMessage, input: { private?: boolean } = {}): Promise<LeadTurnResult | undefined> {
      if (!['human', 'agent'].includes(message.author.type) || message.author.type === 'agent' && message.author.role === 'lead' || !(input.private || message.mentions?.includes('lead') || /(^|\s)@lead\b/i.test(message.text))) return Promise.resolve(undefined)
      if (message.roomId !== requirementId) return Promise.reject(new Error('消息不属于当前需求'))
      return serial(requirementId, async () => {
        thinking.add(requirementId)
        try { await setPresence(requirementId, 'thinking'); return await turn(requirementId, message) }
        finally { thinking.delete(requirementId); await refreshPresence(requirementId) }
      })
    },
    getPresence: (requirementId: string): LeadPresence => ({ ...(presence.get(requirementId) ?? { state: 'idle', since: new Date().toISOString() }) }),
    onRunEvent, onAttention: async (item: AttentionItem) => { try { return await onAttention(item) } finally { await refreshPresence(item.requirementId) } }, resumeTask,
    async drain(): Promise<void> {
      while (queues.size || jobs.size) await Promise.all([...queues.values(), ...jobs])
    },
  }
}
