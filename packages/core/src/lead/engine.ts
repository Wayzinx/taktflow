import { delegationOrigin } from './delegation.js'
import { trackTaskExecution } from './receipts.js'
import { AsyncLocalStorage } from 'node:async_hooks'
import type { Engine, ProjectStores } from '../interfaces.js'
import type { AgentProfile, EventEnvelope, RoomMessage } from '../types.js'
import type { LeadRuntimeOptions, TaskRunState } from './contracts.js'

interface Invocation {
  message: RoomMessage
  title: string
  profiles: Record<string, AgentProfile>
  created(state: TaskRunState): Promise<void>
  kind: 'task' | 'workflow'
  origin?: TaskRunState['origin']
  release?: () => void
}

export function createLeadEngine(options: LeadRuntimeOptions, profiles: Record<string, AgentProfile>, onRunEvent: (runId: string, event: EventEnvelope) => Promise<void>, audit: (runId: string, message: unknown) => Promise<unknown>): (invocation: Invocation) => Engine {
  const { stores } = options
  const invocation = new AsyncLocalStorage<Invocation>()
  // 同一引擎共享写守卫的并发窗口；异步上下文保证评审作者仍取得该任务收窄后的角色权限。
  const scopedProfiles = new Proxy(profiles, { get: (target, key, receiver) =>
    typeof key === 'string' && invocation.getStore() ? invocation.getStore()!.profiles[key] : Reflect.get(target, key, receiver) })
  const runs = Object.create(stores.runs) as ProjectStores['runs']
  // 临时任务与 Lead 回合不能覆盖需求的流水线阶段和交付状态。
  runs.list = async (filter) => (await stores.runs.list(filter)).filter((run) => (run as TaskRunState).kind !== 'task' && run.workflowId !== 'lead' && !run.workflowId.startsWith('task:'))
  runs.create = async (state, snapshot) => {
    const scope = invocation.getStore()
    if (!scope) throw new Error('缺少 Lead 引擎调用上下文')
    Object.assign(state, { kind: scope.kind, origin: scope.origin ?? { kind: 'chat', messageId: scope.message.id, by: scope.message.author, title: scope.title, ...await delegationOrigin(stores, scope.message) } })
    scope.release = trackTaskExecution(stores, state.runId)
    await stores.runs.create(state, snapshot)
    await audit(state.runId, { kind: 'lead.origin', onBehalfOf: state.origin!.by, messageId: scope.message.id })
    await scope.created(state)
  }
  const events: ProjectStores['events'] = {
    append: async (runId, input) => { const event = await stores.events.append(runId, input); await onRunEvent(runId, event); return event },
    read: stores.events.read.bind(stores.events), subscribe: stores.events.subscribe.bind(stores.events), verify: stores.events.verify.bind(stores.events),
  }
  const engine = options.engineFactory({ stores: { ...stores, runs, events }, profiles: scopedProfiles, harnesses: options.harnesses })
  async function execute<T>(scope: Invocation, work: () => Promise<T>, runId?: string): Promise<T> {
    const current = { ...scope, release: runId ? trackTaskExecution(stores, runId) : undefined }
    try { return await invocation.run(current, work) }
    finally { current.release?.() }
  }
  return (scope) => ({
    start: (input) => execute(scope, () => engine.start(input)),
    resume: (runId, workflow, opts) => execute(scope, () => engine.resume(runId, workflow, opts), runId),
    cancel: (runId) => invocation.run(scope, () => engine.cancel(runId)),
    markStale: (runId, cause) => invocation.run(scope, () => engine.markStale(runId, cause)),
  })
}
