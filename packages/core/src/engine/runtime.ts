import { captureRewindPoint, captureNodeChanges } from '../insights/changes.js'
import { reconcileAssumptions } from '../attention/timebox.js'
import { join, relative } from 'node:path'
import type { AttentionItem, EngineDeps } from '../interfaces.js'
import type { Actor, AgentNodeDef, ArtifactRef, FailureRecord, EventPayloads, HumanNodeDef, NodeContext, NodeDef, NodeState, PlannedItem, RunState, WorkflowDefinition } from '../types.js'
import { readJsonFile, writeFileAtomic } from '../store/fs-utils.js'
import type { RunGraphNode } from '../store/run-graph.js'
import { answerOrRead, recordAnswerOnce } from './answers.js'
import { updateRequirement } from './requirement.js'
import { snapshotWorkflow } from '../store/snapshot.js'
import { runDir } from '../store/paths.js'
import { collectOutputs, readCurrent, resolveInputs } from './artifacts.js'
import { expandPlanner, qualify, validateDag, type Entry, type Graph } from './graph.js'
import { WriteGuard } from './guard.js'
import { saveWorktreeDiff, recordKnowledgeUsage, workingDirectory } from './execution.js'
import { BlockedError, callHarness, type Emit, type HarnessHost } from './harness.js'
import { command, Semaphore } from './process.js'
import { BudgetGuard } from './budget.js'
import { failureCode, FailureError, recordFailure } from './fingerprint.js'
import { serializePlannerGroups } from './nodes/planner.js'
import { validateWorkflowHarnesses } from './selection.js'

export interface EngineOptions { concurrency?: number; now?: () => Date; harnessOverride?: string; autoApprove?: boolean; actor?: Actor }
export type GraphRecord = RunGraphNode
export interface RuntimeRecord { failureHistory?: Record<string, FailureRecord[]>; retryFingerprints?: Record<string, string>; budgetAnswers?: string[]; reviews?: Record<string, ReviewProgress>; feedback?: Record<string, string>; nodes?: GraphRecord[]; requests: Record<string, string>; attempts?: Record<string, number>; reservedAttempts?: Record<string, number> }
export { system } from './actor.js'
import { system } from './actor.js'
import { postEventMessage } from './chat-events.js'
import { run as runReview, answerReview, type ReviewProgress } from './nodes/review.js'
import { run as runGate } from './nodes/gate.js'
import { run as runJudge } from './nodes/judge.js'
import { run as runLoop } from './nodes/loop.js'
import { run as runPlanner } from './nodes/planner.js'
const done = (node: NodeState) => node.status === 'succeeded' || node.status === 'skipped'
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error)
const fresh = (id: string, iteration?: number, attempts = 0): NodeState => ({ id, status: 'pending', attempts, outputs: [], iteration })
export const runtimeFile = (deps: EngineDeps, runId: string) => join(runDir(deps.stores.taktDir, runId), 'engine.json')

export class Runtime implements HarnessHost {
  readonly graph: Graph = new Map()
  readonly controller = new AbortController()
  readonly semaphore: Semaphore
  readonly guard: WriteGuard
  readonly override?: string
  readonly reviews: Record<string, ReviewProgress> = {}
  readonly feedback: Record<string, string> = {}
  readonly requests: Record<string, string> = {}
  readonly budget: BudgetGuard
  private readonly retryFingerprints: Record<string, string> = {}
  private readonly failureHistory: Record<string, FailureRecord[]> = {}
  private readonly lessonRecalls = new Map<string, Awaited<ReturnType<NonNullable<EngineDeps['lessons']>['recall']>>>()
  private saves = Promise.resolve()
  private readonly restarting = new Set<string>()
  private readonly attempts: Record<string, number> = {}
  private readonly reservedAttempts: Record<string, number> = {}
  private logs: Promise<void>[] = []
  // 运行中回答待办（docs/dev/m8-backend-c5.md 之后的补丁）：answered 记"有新回答"，wake 叫醒正在等节点的顶层调度；closed 之后交回调用方续跑
  private answered = false
  private wake?: () => void
  private closed = false
  /** 本进程里已经按回答处理过的待办；「交给人处理」之后节点仍挂着同一个待办，不能再处理一遍。 */
  private readonly consumed = new Set<string>()
  constructor(readonly deps: EngineDeps, readonly state: RunState, readonly workflow: WorkflowDefinition, readonly options: EngineOptions, guard?: WriteGuard) {
    this.semaphore = new Semaphore(Math.max(1, Math.floor(Math.min(options.concurrency ?? 4, state.budget?.concurrency ?? Infinity))))
    this.budget = new BudgetGuard(this, () => this.persistGraph())
    this.guard = guard ?? new WriteGuard(deps.stores.projectDir, relative(deps.stores.projectDir, deps.stores.paths.requirements))
    this.override = options.harnessOverride
  }
  get signal(): AbortSignal { return this.controller.signal }
  timestamp = (): string => (this.options.now?.() ?? new Date()).toISOString()
  save(): Promise<void> {
    const snapshot = structuredClone(this.state)
    const next = this.saves.then(async () => {
      await this.deps.stores.runs.save(snapshot)
      const persisted = await this.deps.stores.runs.get(this.state.runId)
      if (!persisted) return
      for (const node of Object.values(persisted.nodes)) {
        const local = this.state.nodes[node.id]
        const submitted = snapshot.nodes[node.id]
        // pending/ready 是恢复到新尝试的过渡，旧墓碑不能阻止调度；新尝试由 store 校验版本。
        if (node.status === 'stale' && local && submitted && !this.restarting.has(node.id)
          && local.attempts === submitted.attempts && local.iteration === submitted.iteration) local.status = 'stale'
      }
      if (this.state.status === 'succeeded' && Object.values(this.state.nodes).some((node) => node.status === 'stale')) this.state.status = 'failed'
      if (persisted.status === 'cancelled' && !this.signal.aborted) this.controller.abort(new Error('运行已取消'))
    })
    this.saves = next.catch(() => undefined)
    return next
  }
  emit: Emit = async (type, data, nodeId, actor = system) => {
    // 调用身份直接落事件日志，不改变 RunState，避免每次调用重复保存整份状态。
    if (!['harness.message', 'harness.tool_call', 'log', 'knowledge.query', 'context.assembled', 'context.compacted', 'invocation.started', 'invocation.finished'].includes(type)) await this.save()
    if (type === 'node.finished' && nodeId && this.state.nodes[nodeId]?.status === 'stale') return
    if (type === 'run.finished') data = { status: this.state.status } as typeof data
    const event = await this.deps.stores.events.append(this.state.runId, { type, data, nodeId, actor })
    await postEventMessage(this.deps.stores, this.state, event, snapshotWorkflow(this.workflow))
    if (type === 'harness.usage') {
      this.budget.addUsage(data as EventPayloads['harness.usage'])
      await this.budget.check()
    }
  }
  async persistGraph(): Promise<void> {
    for (const node of Object.values(this.state.nodes)) this.attempts[node.id] = Math.max(this.attempts[node.id] ?? 0, node.attempts)
    const record: RuntimeRecord = {
      requests: { ...this.requests }, failureHistory: structuredClone(this.failureHistory), budgetAnswers: [...this.budget.handled], retryFingerprints: { ...this.retryFingerprints },
      reviews: structuredClone(this.reviews), feedback: { ...this.feedback },
      attempts: { ...this.attempts },
      reservedAttempts: { ...this.reservedAttempts },
    }
    const next = this.saves.then(() => writeFileAtomic(runtimeFile(this.deps, this.state.runId), JSON.stringify(record)))
    this.saves = next.catch(() => undefined)
    await next
  }
  add(nodes: NodeDef[], parent?: string, scope = '', item?: PlannedItem, iteration?: number): string[] {
    for (const def of nodes) {
      if (this.graph.has(def.id)) throw new Error(`节点 ID 冲突：${def.id}`)
      this.graph.set(def.id, { def, parent, scope, item, iteration })
      if (!this.state.nodes[def.id]) {
        const attempts = this.attempts[def.id] ?? 0
        // 重建先预留新代际，否则 store 会把旧的较大内层 iteration 合并回来。
        const next = attempts > 0 ? attempts + 1 : 0
        this.state.nodes[def.id] = fresh(def.id, def.kind === 'loop' ? undefined : iteration, next)
        this.state.nodes[def.id]!.failures = this.failureHistory[def.id]
        if (next > 0) {
          this.reservedAttempts[def.id] = next
          this.restarting.add(def.id)
        }
      }
    }
    return nodes.map((node) => node.id)
  }
  async prepare(): Promise<void> {
    await this.budget.initialize()
    validateDag(this.workflow.nodes, new Set(this.workflow.stages.map((stage) => stage.id)))
    const stored = await readJsonFile<RuntimeRecord>(runtimeFile(this.deps, this.state.runId))
    Object.assign(this.requests, stored?.requests)
    Object.assign(this.failureHistory, stored?.failureHistory)
    Object.assign(this.retryFingerprints, stored?.retryFingerprints)
    this.budget.handled.push(...(stored?.budgetAnswers ?? []))
    Object.assign(this.reviews, stored?.reviews)
    Object.assign(this.feedback, stored?.feedback)
    Object.assign(this.attempts, stored?.attempts)
    Object.assign(this.reservedAttempts, stored?.reservedAttempts)
    this.add(this.workflow.nodes)
    // 定义中的函数由调用方提供，展开参数只从已落盘的记录恢复。
    for (const entry of this.graph.values()) {
      const node = entry.def
      const ns = this.state.nodes[node.id]!
      if (node.kind === 'loop' && ns.iteration !== undefined) this.addLoop(entry, ns.iteration)
      if (node.kind === 'planner') {
        const expansion = this.state.expansions.find((item) => item.plannerId === node.id)
        if (expansion) {
          const groups = expandPlanner(node, expansion.items)
          serializePlannerGroups(groups, this.deps.profiles)
          const ids = groups.flatMap((group) => group.nodes.map((child) => child.id))
          if (JSON.stringify(ids) !== JSON.stringify(expansion.nodeIds)) throw new Error(`planner 展开定义已改变：${node.id}`)
          const definitions = snapshotWorkflow({ ...this.workflow, nodes: groups.flatMap((group) => group.nodes) }).nodes
          if (expansion.nodes && JSON.stringify(definitions) !== JSON.stringify(expansion.nodes)) throw new Error(`planner 展开定义已改变：${node.id}`)
          validateWorkflowHarnesses({ ...this.workflow, nodes: groups.flatMap((group) => group.nodes) }, { config: this.deps.stores.config, profiles: this.deps.profiles, harnesses: this.deps.harnesses }, this.override)
          expansion.nodes ??= definitions
          for (const group of groups) this.add(group.nodes, node.id, group.scope, group.item, entry.iteration)
        }
      }
    }
    await this.persistGraph()
    await this.save()
  }
  removeChildren(parent: string): void {
    for (const id of [...this.graph.keys()]) if (id.startsWith(`${parent}/`)) {
      if (this.state.nodes[id]!.failures) this.failureHistory[id] = this.state.nodes[id]!.failures!
      // 内层 iteration 会从 1 重新开始，attempts 不能跟着归零，否则旧失效记录会压住新执行。
      this.attempts[id] = Math.max(this.attempts[id] ?? 0, this.state.nodes[id]!.attempts)
      this.graph.delete(id)
      delete this.state.nodes[id]
      delete this.requests[id]
      this.resetReview(id)
      delete this.feedback[id]
      this.restarting.delete(id)
      delete this.reservedAttempts[id]
    }
    this.state.expansions = this.state.expansions.filter((expansion) => !expansion.plannerId.startsWith(`${parent}/`))
  }
  addLoop(entry: Entry, iteration: number): string[] {
    if (entry.def.kind !== 'loop') throw new Error('内部错误：不是 loop')
    return this.add(qualify(entry.def.body, `${entry.def.id}/`), entry.def.id, `${entry.def.id}/`, entry.item, iteration)
  }
  context(entry: Entry, children = false): NodeContext {
    const node = entry.def
    const ns = this.state.nodes[node.id]!
    const scopes = [children ? `${node.id}/` : entry.scope]
    let parent = entry.parent
    while (parent) {
      const ancestor = this.graph.get(parent)
      if (!ancestor) break
      scopes.push(ancestor.scope)
      parent = ancestor.parent
    }
    return {
      runId: this.state.runId, requirementId: this.state.requirementId, nodeId: node.id,
      projectDir: this.deps.stores.projectDir, workspaceDir: this.deps.stores.workspaces.dir(this.state.requirementId),
      signal: this.signal, args: this.state.args, feedback: this.feedback[node.id], iteration: node.kind === 'loop' ? ns.iteration : entry.iteration, item: entry.item,
      resultOf: (id) => {
        for (const scope of scopes) if (Object.hasOwn(this.state.nodes, scope + id)) return this.state.nodes[scope + id]!.result
        return this.state.nodes[id]?.result
      },
      readArtifact: async (path) => (await readCurrent(this.deps.stores, this.state.requirementId, path))?.toString('utf8'),
      log: (message) => {
        const pending = this.emit('log', { level: 'info', message }, node.id)
        void pending.catch(() => undefined)
        this.logs.push(pending)
      },
    }
  }
  private async flushLogs(): Promise<void> { await Promise.all(this.logs.splice(0)) }
  private async finish(entry: Entry, actor = system): Promise<void> {
    this.signal.throwIfAborted()
    const ns = this.state.nodes[entry.def.id]!
    await this.guard.system(this.workspacePaths(entry.def.outputs?.map((output) => output.path)), () =>
      collectOutputs(this.deps.stores, this.state, entry.def, ns, actor, this.emit))
    await saveWorktreeDiff(this, entry.def.id, ns)
    this.signal.throwIfAborted()
    await this.save()
    if (ns.status === 'stale') return
    if (this.deps.stores.kb) {
      try {
        await this.guard.system(['.takt/knowledge/queries.jsonl'], () => recordKnowledgeUsage(this, entry.def.id, ns.outputs))
      } catch {
        await this.emit('log', { level: 'warn', message: '知识引用统计失败，节点结果保留，请检查查询日志' }, ns.id)
      }
    }
    ns.status = 'succeeded'
    ns.endedAt = this.timestamp()
    delete ns.error
    await captureNodeChanges(this.deps.stores, this.state, ns.id, this.deps.repos).catch(async error => {
      await this.emit('log', { level: 'warn', message: `改动记录失败，回退不可用：${errorText(error)}` }, ns.id)
    })
    await this.emit('node.finished', { status: ns.status, outputs: ns.outputs, result: ns.result, usage: ns.usage }, ns.id, actor)
  }
  recordAnswer(item: AttentionItem, actor?: Actor): Promise<void> {
    return recordAnswerOnce(this.deps.stores, this.state.runId, item, actor)
  }
  private async consume(entry: Entry, item: AttentionItem, actor = item.answeredBy ?? system): Promise<void> {
    const ns = this.state.nodes[entry.def.id]!
    this.consumed.add(item.requestId)
    await this.recordAnswer(item, actor)
    if (item.kind === 'retry') {
      if (item.decision === 'choice' && item.answer === '再试一次') {
        const failure = ns.failures?.find((failure) => failure.fingerprint === this.retryFingerprints[ns.id])
        if (failure) failure.count = 0
        ns.status = 'pending'
        delete ns.error
        delete ns.endedAt
        delete this.requests[ns.id]
      } else if (item.answer === '终止运行' || item.decision === 'cancelled') {
        this.state.status = 'cancelled'
        this.controller.abort(new Error('人工终止运行'))
        ns.status = 'cancelled'
      } else {
        ns.status = 'blocked'
        ns.error = '重复失败已交给人处理'
      }
      await this.persistGraph()
      await this.save()
      return
    }
    if (entry.def.kind === 'review') { await answerReview(this, entry, item); await this.save(); return }
    const answer = { decision: item.decision, answer: item.handedBack ? `未获回答，按假设：${item.answer}` : item.answer, ...(item.handedBack ? { handedBack: true } : {}) }
    ns.result = entry.def.kind === 'judge' ? { ...ns.result as object, ...answer } : answer
    if (item.decision === 'cancelled') {
      ns.status = 'cancelled'
      ns.endedAt = this.timestamp()
      await this.save()
    } else if (item.decision === 'reject') {
      ns.status = 'failed'
      ns.error = '人工拒绝'
      ns.endedAt = this.timestamp()
      await this.emit('node.failed', { error: ns.error, attempt: ns.attempts }, ns.id, actor)
    } else await this.finish(entry, actor)
  }
  async retryNodes(nodeIds: string[], reason?: string): Promise<void> {
    const affected = new Set(nodeIds)
    const containers = new Set<string>()
    for (const id of nodeIds) {
      let parent = this.graph.get(id)?.parent
      while (parent) {
        containers.add(parent)
        affected.add(parent)
        parent = this.graph.get(parent)?.parent
      }
    }
    for (let changed = true; changed;) {
      changed = false
      for (const entry of this.graph.values()) {
        if (!affected.has(entry.def.id) && entry.def.needs?.some(id => affected.has(id))) {
          affected.add(entry.def.id)
          changed = true
        }
      }
    }
    const attention = await this.deps.stores.attention.list({ pending: true, requirementId: this.state.requirementId })
    for (const id of affected) {
      const ns = this.state.nodes[id]!
      // 容器只重新进入调度，保留已完成的子节点和展开结果。
      if (!nodeIds.includes(id) && !containers.has(id) && !['skipped', 'cancelled'].includes(ns.status)) continue
      const request = attention.find(item => item.runId === this.state.runId && item.requestId === this.requests[id])
      if (request) {
        const answered = await answerOrRead(this.deps.stores, request, { decision: 'cancelled', answer: '已发起节点重试', by: this.options.actor ?? system })
        await this.recordAnswer(answered)
      }
      this.restarting.add(id)
      delete this.reservedAttempts[id]
      ns.status = 'pending'
      delete ns.error
      delete ns.endedAt
      delete this.requests[id]
    }
    this.state.status = 'running'
    delete this.state.endedAt
    await this.persistGraph()
    await this.emit('run.retried', { nodeIds, reason }, undefined, this.options.actor ?? system)
  }
  async restoreAnswers(): Promise<void> {
    await reconcileAssumptions(this.deps.stores)
    await this.save()
    await this.budget.restore()
    this.semaphore.setLimit(Math.max(1, Math.floor(Math.min(this.options.concurrency ?? 4, this.state.budget?.concurrency ?? Infinity))))
    if (this.state.status === 'cancelled') this.controller.abort(new Error('人工停止运行'))
    const attention = await this.deps.stores.attention.list({ requirementId: this.state.requirementId })
    for (const entry of this.graph.values()) {
      const ns = this.state.nodes[entry.def.id]!
      const correction = attention.find(item => item.kind === 'assumption' && item.assumedFor === this.requests[ns.id] && item.answeredAt && item.answer !== item.assumption)
      if (entry.def.kind === 'human' && ns.status === 'stale' && correction) {
        this.restarting.add(ns.id)
        await this.beginAttempt(ns)
        this.requests[ns.id] = correction.requestId
        await this.persistGraph()
        await this.consume(entry, { ...correction, kind: 'node', handedBack: false })
        continue
      }

      if (ns.status === 'waiting_human' || ns.status === 'blocked' && this.requests[ns.id]) {
        const requestId = this.requests[ns.id]
        const item = requestId ? attention.find((item) => item.requestId === requestId) : undefined
        if (item?.answeredAt) {
          try { await this.consume(entry, item) } catch (error) { await this.fail(ns, error) }
        } else if (!item && (entry.def.kind === 'loop' || entry.def.kind === 'planner')) ns.status = 'pending'
      } else if (['running', 'ready', 'stale'].includes(ns.status)) {
        if (ns.status === 'stale') {
          this.restarting.add(ns.id)
          this.resetReview(ns.id)
          delete this.reservedAttempts[ns.id]
        }
        ns.status = 'pending'
      }
    }
    await this.save()
  }
  async request(entry: Entry, ask: string, form: HumanNodeDef['form'], choices?: string[], signoff = false, boundTo?: ArtifactRef[]): Promise<void> {
    return this.requestAttention(entry, ask, form, choices, signoff, boundTo)
  }
  private async requestAttention(entry: Entry, ask: string, form: HumanNodeDef['form'], choices?: string[], autoApprove = false, boundTo?: ArtifactRef[], kind?: AttentionItem['kind']): Promise<void> {
    const ns = this.state.nodes[entry.def.id]!
    const all = await this.deps.stores.attention.list({ requirementId: this.state.requirementId })
    const base = `${this.state.runId}:${ns.id}`
    const prior = all.filter((item) => item.runId === this.state.runId && item.nodeId === ns.id)
    const requestId = prior.length ? `${base}#${prior.length + 1}` : base
    const timebox = entry.def.kind === 'human' ? entry.def.timebox ?? this.deps.stores.config.human : this.deps.stores.config.human
    const assumption = entry.def.kind === 'human' ? entry.def.assumption : undefined
    const item = await this.deps.stores.attention.create({
      timebox, assumption, requestId, runId: this.state.runId, nodeId: ns.id, requirementId: this.state.requirementId, ask, form, choices, kind, boundTo: boundTo ?? (entry.def.kind === 'human' ? ns.inputs : undefined),
      owner: entry.def.owner, assignees: entry.def.owner ? this.deps.stores.config.members?.filter((member) => member.duties?.includes(entry.def.owner!)).map((member) => member.id) : undefined,
    })
    this.requests[ns.id] = requestId
    if (!this.signal.aborted) ns.status = kind === 'retry' ? 'blocked' : 'waiting_human'
    await this.persistGraph()
    await this.emit('human.requested', { requestId, ask, form, choices, timebox, assumption }, ns.id)
    if (this.signal.aborted) {
      const answered = await answerOrRead(this.deps.stores, item, { decision: 'cancelled', by: system })
      await this.recordAnswer(answered)
      this.signal.throwIfAborted()
    }
    if (autoApprove && this.options.autoApprove) {
      const actor: Actor = { type: 'human', id: 'auto-approve' }
      const answered = await answerOrRead(this.deps.stores, item, {
        decision: form === 'approve' ? 'approve' : form === 'choice' ? 'choice' : undefined,
        answer: form === 'answer' ? '（自动通过）' : form === 'choice' ? choices?.[0] : undefined, by: actor,
      })
      await this.consume(entry, answered, actor)
    }
  }
  /** 运行中有待办被回答：顶层调度还在就叫醒它接着跑并返回 true；已经收尾返回 false，调用方改走续跑。 */
  notifyAnswered(): boolean {
    if (this.closed) return false
    this.answered = true
    this.wake?.()
    return true
  }
  /**
   * 把已经回答、但节点还在等人的待办接上：节点按回答继续，没有自己待办的 loop / planner 容器重新排队，
   * 由调度再进去跑后续子节点。有变化返回 true。
   */
  private async consumeAnswered(): Promise<boolean> {
    const attention = await this.deps.stores.attention.list({ requirementId: this.state.requirementId })
    const containers: NodeState[] = []
    let changed = false
    for (const entry of this.graph.values()) {
      const ns = this.state.nodes[entry.def.id]!
      if (!(ns.status === 'waiting_human' || ns.status === 'blocked' && this.requests[ns.id])) continue
      const requestId = this.requests[ns.id]
      const item = requestId ? attention.find((current) => current.requestId === requestId) : undefined
      if (item?.answeredAt && !this.consumed.has(item.requestId)) {
        changed = true
        try { await this.consume(entry, item) } catch (error) { await this.fail(ns, error) }
      } else if (!item && (entry.def.kind === 'loop' || entry.def.kind === 'planner')) containers.push(ns)
    }
    if (!changed) return false
    for (const ns of containers) if (ns.status === 'waiting_human') ns.status = 'pending'
    await this.save()
    return true
  }
  async schedule(ids: string[], top = false): Promise<void> {
    const running = new Map<string, Promise<void>>()
    while (!this.signal.aborted) {
      if (!await this.budget.check()) break
      if (top && this.answered) {
        this.answered = false
        await this.consumeAnswered()
      }
      for (const id of ids) {
        const ns = this.state.nodes[id]!
        if (ns.status !== 'pending' || running.has(id)) continue
        const entry = this.graph.get(id)!
        if (!(entry.def.needs ?? []).every((dep) => this.state.nodes[dep] && done(this.state.nodes[dep]!))) continue
        const task = this.runNode(entry)
        running.set(id, task)
      }
      if (!running.size) break
      const woken = top ? new Promise<undefined>((resolve) => { this.wake = () => resolve(undefined) }) : undefined
      const result = await Promise.race([...[...running].map(async ([id, task]) => { await task; return id }), ...(woken ? [woken] : [])])
      if (top) this.wake = undefined
      if (result !== undefined) running.delete(result)
    }
    await Promise.all(running.values())
  }
  private async fail(ns: NodeState, error: unknown): Promise<void> {
    if (ns.status === 'stale' && !this.signal.aborted) {
      await this.emit('log', { level: 'warn', message: `忽略过期执行的失败：${errorText(error)}` }, ns.id)
      return
    }
    ns.status = this.signal.aborted ? 'cancelled' : error instanceof BlockedError ? 'blocked' : 'failed'
    ns.error = errorText(error)
    try { await captureNodeChanges(this.deps.stores, this.state, ns.id, this.deps.repos) } catch (captureError) {
      await this.emit('log', { level: 'warn', message: `改动记录失败，回退不可用：${errorText(captureError)}` }, ns.id)
    }
    ns.endedAt = this.timestamp()
    await this.emit('node.failed', { error: ns.error, attempt: ns.attempts }, ns.id)
  }
  private async runNode(entry: Entry): Promise<void> {
    this.state.nodes[entry.def.id]!.status = 'ready'
    await this.emit('node.ready', {}, entry.def.id)
    if (entry.def.kind === 'loop' || entry.def.kind === 'planner' || entry.def.kind === 'review') await this.runAttempts(entry)
    else await this.semaphore.use(async () => {
      if (!await this.budget.check()) { this.state.nodes[entry.def.id]!.status = 'pending'; return }
      await this.runAttempts(entry)
    })
  }
  private async beginAttempt(ns: NodeState, announce = true): Promise<void> {
    ns.status = 'running'
    const reserved = this.reservedAttempts[ns.id] === ns.attempts
    if (!reserved) ns.attempts++
    delete this.reservedAttempts[ns.id]
    this.restarting.delete(ns.id)
    ns.startedAt = this.timestamp()
    delete ns.endedAt
    if (reserved) await this.persistGraph()
    if (announce) await this.announceAttempt(this.graph.get(ns.id)!, ns)
    else await this.save()
  }
  private async announceAttempt(entry: Entry, ns: NodeState): Promise<void> {
    if (entry.def.kind === 'agent' && entry.def.repo) await workingDirectory(this, entry.def, this.context(entry), ns)
    // 回退能力不可用不能阻断已成功引导的执行面；缺少回退点时预览会拒绝操作。
    const rewindPoint = await captureRewindPoint(this.deps.stores, this.state, entry.def, ns).catch(async error => {
      await this.emit('log', { level: 'warn', message: `回退点记录失败，回退不可用：${errorText(error)}` }, ns.id)
      return undefined
    })
    await this.emit('node.started', { attempt: ns.attempts, iteration: ns.iteration, rewindPoint }, ns.id)
  }
  async skipNode(id: string, started = false): Promise<void> {
    const ns = this.state.nodes[id]!
    if (!started) {
      ns.status = 'ready'
      await this.emit('node.ready', {}, id)
      if ((ns.status as NodeState['status']) === 'stale') return
      await this.beginAttempt(ns, false)
    }
    this.signal.throwIfAborted()
    if (ns.status === 'stale') return
    ns.status = 'skipped'
    ns.inputs = []
    ns.outputs = []
    delete ns.result
    delete ns.error
    ns.endedAt = this.timestamp()
    await this.emit('node.finished', { status: 'skipped', outputs: [] }, id)
  }
  private async runAttempts(entry: Entry): Promise<void> {
    const node = entry.def
    const ns = this.state.nodes[node.id]!
    for (let retry = 0; retry <= (node.retry?.max ?? 0); retry++) {
      if (ns.status === 'stale') return
      if (this.signal.aborted) { ns.status = 'cancelled'; await this.save(); return }
      if (retry > 0) {
        ns.status = 'ready'
        await this.emit('node.ready', {}, node.id)
      }
      try {
        this.signal.throwIfAborted()
        if (!await this.budget.check()) { ns.status = 'pending'; return }
        delete ns.checks
        await this.beginAttempt(ns, false)
        if ((ns.status as NodeState['status']) === 'stale') return
        const ctx = this.context(entry)
        if (node.when && !await node.when(ctx)) {
          await this.skipNode(node.id, true)
          return
        }
        await this.announceAttempt(entry, ns)
        const inputs = await this.guard.system(this.workspacePaths(node.inputs?.map((input) => input.path)), () =>
          resolveInputs(this.deps.stores, this.state, node, this.emit))
        ns.inputs = node.kind === 'review' && this.reviews[node.id]?.rounds.length ? ns.inputs : inputs
        await this.save()
        if ((ns.status as NodeState['status']) === 'stale') return
        const actor = await this.execute(entry, ctx)
        await this.flushLogs()
        if (this.state.nodes[node.id] === ns && ns.status === 'running') await this.finish(entry, actor)
        await this.recordLessonOutcome(entry, ns)
        return
      } catch (error) {
        await this.flushLogs()
        await this.fail(ns, error)
        await this.recordLessonOutcome(entry, ns)
        if (!this.signal.aborted && (ns.status as NodeState['status']) !== 'stale' && !(error instanceof FailureError && error.recorded)) {
          if (await this.noteFailure(entry, failureCode(error), error instanceof FailureError ? error.target : undefined, errorText(error))) return
        }
        if (this.state.nodes[node.id]!.status !== 'failed' || retry === (node.retry?.max ?? 0)) return
      }
    }
  }
  setLessonRecall(nodeId: string, recalled: Awaited<ReturnType<NonNullable<EngineDeps['lessons']>['recall']>> | undefined): void {
    if (recalled) this.lessonRecalls.set(nodeId, recalled)
  }
  private async recordLessonOutcome(entry: Entry, ns: NodeState): Promise<void> {
    if (entry.def.kind !== 'agent' || ns.attempts !== 1 || !this.deps.lessons || !['succeeded', 'failed'].includes(ns.status)) return
    const recalled = this.lessonRecalls.get(ns.id)
    if (!recalled?.lessons.length) return
    this.lessonRecalls.delete(ns.id)
    const changes = await this.deps.lessons.record({ runId: this.state.runId, nodeId: ns.id, ids: recalled.lessons.map((lesson) => lesson.id),
      holdout: recalled.holdout, outcome: ns.status === 'succeeded' ? 'helped' : 'hurt' })
    for (const change of changes) await this.emit('lesson.updated', change, ns.id)
  }
  async failureSource(entry: Entry): Promise<NodeState> {
    const ns = this.state.nodes[entry.def.id]!
    const inputs = await this.guard.system(this.workspacePaths(entry.def.inputs?.map((input) => input.path)), () =>
      resolveInputs(this.deps.stores, this.state, entry.def, this.emit))
    const worktree = ns.worktree ?? (await this.deps.stores.events.read(this.state.runId, { nodeId: ns.id, types: ['worktree.created'] })).map((event) => event.data as EventPayloads['worktree.created']).at(-1)
    return { ...ns, inputs, worktree }
  }
  async noteFailure(entry: Entry, code: string, target?: string, message?: string, source?: NodeState): Promise<boolean> {
    const ns = this.state.nodes[entry.def.id]!
    let failure: FailureRecord
    try { failure = await recordFailure(ns, code, target, this.timestamp(), message, source) } catch (error) {
      ns.status = 'blocked'
      ns.error = `无法确定失败输入身份：${errorText(error)}`
      await this.emit('node.failed', { error: ns.error, attempt: ns.attempts }, ns.id)
      return true
    }
    this.failureHistory[ns.id] = ns.failures!
    await this.save()
    if (code === 'judge:flaky' || failure.count < (this.deps.stores.config.retry?.maxSameFailure ?? 2)) return false
    ns.error = `同样的失败已出现 ${failure.count} 次：${message ?? code}`
    ns.status = 'blocked'
    await this.emit('retry.suppressed', { fingerprint: failure.fingerprint, code, count: failure.count, reason: ns.error }, ns.id)
    if (entry.def.kind === 'loop') return true
    let parent = entry.parent
    while (parent) {
      const ancestor = this.graph.get(parent)
      if (ancestor?.def.kind === 'loop') return true
      parent = ancestor?.parent
    }
    this.retryFingerprints[ns.id] = failure.fingerprint
    await this.requestAttention(entry, ns.error, 'choice', ['再试一次', '交给人处理', '终止运行'], false, ns.inputs, 'retry')
    return true
  }
  workspacePaths(paths: string[] = []): string[] {
    const prefix = relative(this.deps.stores.projectDir, this.deps.stores.workspaces.dir(this.state.requirementId))
    return paths.map((path) => `${prefix}/${path}`)
  }
  private assumptionPrompt(entry: Entry, prompt: AgentNodeDef['prompt']): AgentNodeDef['prompt'] {
    const seen = new Set<string>()
    const visit = (id: string) => {
      for (const need of this.graph.get(id)?.def.needs ?? []) if (!seen.has(need)) { seen.add(need); visit(need) }
      const parent = this.graph.get(id)?.parent
      if (parent && !seen.has(parent)) { seen.add(parent); visit(parent) }
    }
    visit(entry.def.id)
    const notes = [...seen].flatMap(id => {
      const result = this.state.nodes[id]?.result as { handedBack?: boolean; answer?: string } | undefined
      return result?.handedBack && result.answer ? [result.answer] : []
    })
    if (!notes.length) return prompt
    return async ctx => `${notes.join('\n')}\n\n${typeof prompt === 'function' ? await prompt(ctx) : prompt}`
  }
  private environment(ctx: NodeContext): Record<string, string> {
    return { TAKT_RUN_ID: ctx.runId, TAKT_REQ: ctx.requirementId, TAKT_WORKSPACE: ctx.workspaceDir, TAKT_NODE: ctx.nodeId }
  }
  async shell(text: string, ctx: NodeContext, timeoutMs?: number): Promise<{ code: number; output: string }> {
    this.signal.throwIfAborted()
    const signal = timeoutMs ? AbortSignal.any([this.signal, AbortSignal.timeout(timeoutMs)]) : this.signal
    const result = await this.guard.system(this.workspacePaths(this.graph.get(ctx.nodeId)?.def.outputs?.map((output) => output.path)),
      () => command(text, ctx.projectDir, this.environment(ctx), signal), true)
    await this.emit('log', { level: result.code ? 'error' : 'info', message: result.output }, ctx.nodeId)
    return result
  }
  async model(entry: Entry, ctx: NodeContext, role: string, prompt: string | AgentNodeDef['prompt'], schema: Record<string, unknown>): Promise<unknown> {
    const node = entry.def
    const result = await callHarness(this, {
      ...node, kind: 'agent', role, prompt: this.assumptionPrompt(entry, prompt), resultSchema: schema,
      harness: 'harness' in node ? node.harness : undefined,
    }, ctx, this.state.nodes[node.id]!, node.kind === 'planner')
    return result.data
  }
  private async execute(entry: Entry, ctx: NodeContext): Promise<Actor> {
    const node = entry.def
    const ns = this.state.nodes[node.id]!
    switch (node.kind) {
      case 'script': {
        if (typeof node.run === 'string') {
          const result = await this.shell(node.run, ctx, node.timeoutMs)
          if (result.code !== 0) throw new Error(`命令退出码 ${result.code}：${result.output}`)
        } else {
          this.signal.throwIfAborted()
          const run = node.run
          const result = await this.guard.system(this.workspacePaths(node.outputs?.map((output) => output.path)), () => run(ctx), true)
          ns.result = result?.data
          if (result?.status === 'blocked') throw new BlockedError(result.message ?? '脚本被阻塞')
          if (result?.status === 'failed') throw new Error(result.message ?? '脚本失败')
        }
        break
      }
      case 'agent': {
        const result = await callHarness(this, { ...node, prompt: this.assumptionPrompt(entry, node.prompt) }, ctx, ns, false)
        ns.result = result.data
        return result.actor
      }
      case 'human': await this.request(entry, node.ask, node.form, node.choices, true); break
      case 'gate': await runGate(this, entry, ctx); break
      case 'judge': await runJudge(this, entry, ctx); break
      case 'loop': await runLoop(this, entry, ctx); break
      case 'planner': await runPlanner(this, entry, ctx); break
      case 'review': await runReview(this, entry, ctx); break
      case 'subflow': throw new Error('not implemented')
    }
    return system
  }
  containerState(ns: NodeState, ids: string[]): void {
    this.signal.throwIfAborted()
    if (ids.every((id) => done(this.state.nodes[id]!))) return
    if (this.budget.paused || ids.some((id) => this.state.nodes[id]!.status === 'waiting_human' || this.state.nodes[id]!.status === 'blocked' && this.requests[id])) ns.status = 'waiting_human'
    else {
      const unfinished = ids.filter((id) => !done(this.state.nodes[id]!))
      // 指纹按失败的子节点和它们各自的失败算：不同子节点、不同原因的失败不能算成"同样的失败"
      const causes = unfinished.flatMap((id) => {
        const child = this.state.nodes[id]!
        if (child.status !== 'failed' && child.status !== 'blocked') return []
        const latest = [...child.failures ?? []].sort((a, b) => a.lastAt.localeCompare(b.lastAt)).at(-1)
        return [`${id}@${latest?.fingerprint ?? child.status}`]
      })
      throw new FailureError(`子 DAG 未完成：${unfinished.join(', ')}`, 'subdag', causes.sort().join(',') || undefined)
    }
  }
  private resetReview(id: string): void {
    const progress = this.reviews[id]
    if (progress) this.reviews[id] = { rounds: [], phase: 'review', history: [...(progress.history ?? []), ...progress.rounds] }
  }
  async rework(entry: Entry, target: string, feedback: string): Promise<void> {
    const origin = entry.def.id
    const scope = [...this.graph.values()].filter((candidate) => candidate.scope === entry.scope)
    const ancestors = new Set<string>([origin])
    const visit = (id: string): void => {
      for (const dep of this.graph.get(id)?.def.needs ?? []) {
        if (!scope.some((candidate) => candidate.def.id === dep) || ancestors.has(dep)) continue
        ancestors.add(dep); visit(dep)
      }
    }
    visit(origin)
    if (!ancestors.has(target) || target === origin) throw new Error(`打回目标必须在同作用域上游：${target}`)
    const reset = new Set([target])
    for (let changed = true; changed;) {
      changed = false
      for (const candidate of scope) if (ancestors.has(candidate.def.id) && !reset.has(candidate.def.id)
        && candidate.def.needs?.some((id) => reset.has(id))) { reset.add(candidate.def.id); changed = true }
    }
    const count = (this.state.nodes[target]!.reworks ?? 0) + 1
    for (const id of reset) {
      const old = this.state.nodes[id]!
      const next = fresh(id, old.iteration, old.attempts + 1)
      next.worktree = old.worktree
      next.failures = old.failures
      next.reworks = id === target ? count : old.reworks
      this.state.nodes[id] = next
      this.reservedAttempts[id] = next.attempts
      this.restarting.add(id)
      delete this.requests[id]
      this.resetReview(id)
      const kind = this.graph.get(id)!.def.kind
      if (kind === 'loop' || kind === 'planner') {
        this.removeChildren(id)
        this.state.expansions = this.state.expansions.filter((expansion) => expansion.plannerId !== id)
      }
      this.feedback[id] = feedback
    }
    await this.persistGraph()
    await this.emit('rework.started', { from: origin, to: target, count, feedback, reset: [...reset] }, origin)
  }
  async run(): Promise<RunState> {
    if (!this.signal.aborted) {
      this.state.status = 'running'
      delete this.state.endedAt
    }
    await this.save()
    await updateRequirement(this.deps.stores, this.state, snapshotWorkflow(this.workflow))
    // 长时间运行的脚本可能不报告 token；分钟预算仍需及时通知，已启动的节点继续完成。
    const monitor = this.state.budget?.minutes ? setInterval(() => {
      const pending = this.budget.check().then(() => undefined)
      void pending.catch(() => undefined)
      this.logs.push(pending)
    }, Math.max(10, Math.min(1000, this.state.budget.minutes * 6000))) : undefined
    try {
      const ids = this.workflow.nodes.map((node) => node.id)
      for (;;) {
        await this.schedule(ids, true)
        if (this.signal.aborted) break
        // 收尾前再扫一遍：别的分支还在跑时回答的待办，回答已落盘但没送到节点
        this.answered = false
        if (await this.consumeAnswered() || this.answered) continue
        this.closed = true
        break
      }
    } finally {
      this.closed = true
      if (monitor) clearInterval(monitor)
      await this.flushLogs()
    }
    if (this.signal.aborted) this.state.status = 'cancelled'
    else if (this.budget.paused || (await this.deps.stores.attention.list({ pending: true, requirementId: this.state.requirementId })).some((item) => item.runId === this.state.runId && this.requests[item.nodeId] === item.requestId && this.state.nodes[item.nodeId]?.status === 'blocked') || Object.values(this.state.nodes).some((node) => node.status === 'waiting_human')) this.state.status = 'waiting_human'
    else if (this.workflow.nodes.every((node) => done(this.state.nodes[node.id]!))) this.state.status = 'succeeded'
    else this.state.status = 'failed'
    this.state.endedAt = this.timestamp()
    await this.emit('run.finished', { status: this.state.status })
    await updateRequirement(this.deps.stores, this.state, snapshotWorkflow(this.workflow))
    return structuredClone(this.state)
  }
}
