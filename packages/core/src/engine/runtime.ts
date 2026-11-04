import { join } from 'node:path'
import type { AttentionItem, EngineDeps } from '../interfaces.js'
import type { Actor, AgentNodeDef, GateCheckResult, HumanNodeDef, JudgeNodeDef, JudgeVerdict, NodeContext, NodeDef, NodeState, PlannedItem, RunState, WorkflowDefinition } from '../types.js'
import { readJsonFile, writeFileAtomic } from '../store/fs-utils.js'
import { runDir } from '../store/paths.js'
import { sha256 } from '../util/hash.js'
import { collectOutputs, readCurrent, resolveInputs } from './artifacts.js'
import { expandPlanner, qualify, validateDag, type Entry, type Graph } from './graph.js'
import { WriteGuard } from './guard.js'
import { BlockedError, callHarness, type Emit, type HarnessHost } from './harness.js'
import { command, Semaphore } from './process.js'

export interface EngineOptions { concurrency?: number; now?: () => Date; harnessOverride?: string; autoApprove?: boolean }
export interface GraphRecord { id: string; needs: string[]; parent?: string }
export interface RuntimeRecord { nodes: GraphRecord[]; requests: Record<string, string> }
export const system: Actor = { type: 'system', id: 'engine' }
const done = (node: NodeState) => node.status === 'succeeded' || node.status === 'skipped'
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error)
const fresh = (id: string, iteration?: number): NodeState => ({ id, status: 'pending', attempts: 0, outputs: [], iteration })
const objectSchema = (properties: Record<string, unknown>, required = Object.keys(properties)) => ({ type: 'object', properties, required })
export const runtimeFile = (deps: EngineDeps, runId: string) => join(runDir(deps.stores.taktDir, runId), 'engine.json')

export class Runtime implements HarnessHost {
  readonly graph: Graph = new Map()
  readonly controller = new AbortController()
  readonly semaphore: Semaphore
  readonly guard: WriteGuard
  readonly override?: string
  readonly requests: Record<string, string> = {}
  private saves = Promise.resolve()
  private answers = Promise.resolve()
  private logs: Promise<void>[] = []
  constructor(readonly deps: EngineDeps, readonly state: RunState, readonly workflow: WorkflowDefinition, readonly options: EngineOptions, guard?: WriteGuard) {
    this.semaphore = new Semaphore(options.concurrency ?? 4)
    this.guard = guard ?? new WriteGuard(deps.stores.projectDir)
    this.override = options.harnessOverride
  }
  get signal(): AbortSignal { return this.controller.signal }
  timestamp = (): string => (this.options.now?.() ?? new Date()).toISOString()
  save(): Promise<void> {
    const snapshot = structuredClone(this.state)
    const next = this.saves.then(() => this.deps.stores.runs.save(snapshot))
    this.saves = next.catch(() => undefined)
    return next
  }
  emit: Emit = async (type, data, nodeId, actor = system) => {
    await this.save()
    await this.deps.stores.events.append(this.state.runId, { type, data, nodeId, actor })
  }
  async persistGraph(): Promise<void> {
    const record: RuntimeRecord = {
      nodes: [...this.graph].map(([id, entry]) => ({ id, needs: entry.def.needs ?? [], parent: entry.parent })),
      requests: { ...this.requests },
    }
    const next = this.saves.then(() => writeFileAtomic(runtimeFile(this.deps, this.state.runId), JSON.stringify(record)))
    this.saves = next.catch(() => undefined)
    await next
  }
  private add(nodes: NodeDef[], parent?: string, scope = '', item?: PlannedItem, iteration?: number): string[] {
    for (const def of nodes) {
      if (this.graph.has(def.id)) throw new Error(`节点 ID 冲突：${def.id}`)
      this.graph.set(def.id, { def, parent, scope, item, iteration })
      this.state.nodes[def.id] ??= fresh(def.id, def.kind === 'loop' ? undefined : iteration)
    }
    return nodes.map((node) => node.id)
  }
  async prepare(): Promise<void> {
    validateDag(this.workflow.nodes)
    const stored = await readJsonFile<RuntimeRecord>(runtimeFile(this.deps, this.state.runId))
    Object.assign(this.requests, stored?.requests)
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
          const ids = groups.flatMap((group) => group.nodes.map((child) => child.id))
          if (JSON.stringify(ids) !== JSON.stringify(expansion.nodeIds)) throw new Error(`planner 展开定义已改变：${node.id}`)
          for (const group of groups) this.add(group.nodes, node.id, group.scope, group.item, entry.iteration)
        }
      }
    }
    await this.persistGraph()
    await this.save()
  }
  private addLoop(entry: Entry, iteration: number): string[] {
    if (entry.def.kind !== 'loop') throw new Error('内部错误：不是 loop')
    return this.add(qualify(entry.def.body, `${entry.def.id}/`), entry.def.id, `${entry.def.id}/`, entry.item, iteration)
  }
  private context(entry: Entry, children = false): NodeContext {
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
      args: this.state.args, iteration: node.kind === 'loop' ? ns.iteration : entry.iteration, item: entry.item,
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
    await collectOutputs(this.deps.stores, this.state, entry.def, ns, actor, this.emit)
    this.signal.throwIfAborted()
    if (ns.status === 'stale') return
    ns.status = 'succeeded'
    ns.endedAt = this.timestamp()
    delete ns.error
    await this.emit('node.finished', { status: ns.status, outputs: ns.outputs, result: ns.result, usage: ns.usage }, ns.id, actor)
  }
  recordAnswer(item: AttentionItem, actor = system): Promise<void> {
    const pending = this.answers.then(async () => {
      const events = await this.deps.stores.events.read(this.state.runId, { nodeId: item.nodeId, types: ['human.answered'] })
      if (!events.some((event) => (event.data as { requestId: string }).requestId === item.requestId)) {
        await this.emit('human.answered', { requestId: item.requestId, decision: item.decision, answer: item.answer }, item.nodeId, actor)
      }
    })
    this.answers = pending.catch(() => undefined)
    return pending
  }
  private async consume(entry: Entry, item: AttentionItem, actor = system): Promise<void> {
    const ns = this.state.nodes[entry.def.id]!
    await this.recordAnswer(item, actor)
    const answer = { decision: item.decision, answer: item.answer }
    ns.result = entry.def.kind === 'judge' ? { ...ns.result as object, ...answer } : answer
    if (item.decision === 'reject') {
      ns.status = 'failed'
      ns.error = '人工拒绝'
      ns.endedAt = this.timestamp()
      await this.emit('node.failed', { error: ns.error, attempt: ns.attempts }, ns.id, actor)
    } else await this.finish(entry, actor)
  }
  async restoreAnswers(): Promise<void> {
    const attention = await this.deps.stores.attention.list({ requirementId: this.state.requirementId })
    for (const entry of this.graph.values()) {
      const ns = this.state.nodes[entry.def.id]!
      if (ns.status === 'waiting_human') {
        const requestId = this.requests[ns.id]
        const item = requestId ? attention.find((item) => item.requestId === requestId) : undefined
        if (item?.answeredAt) {
          try { await this.consume(entry, item) } catch (error) { await this.fail(ns, error) }
        } else if (!item && (entry.def.kind === 'loop' || entry.def.kind === 'planner')) ns.status = 'pending'
      } else if (['running', 'ready', 'stale'].includes(ns.status)) ns.status = 'pending'
    }
    await this.save()
  }
  private async request(entry: Entry, ask: string, form: HumanNodeDef['form'], choices?: string[], autoApprove = false): Promise<void> {
    const ns = this.state.nodes[entry.def.id]!
    const all = await this.deps.stores.attention.list({ requirementId: this.state.requirementId })
    const base = `${this.state.runId}:${ns.id}`
    const prior = all.filter((item) => item.runId === this.state.runId && item.nodeId === ns.id)
    const requestId = prior.length ? `${base}:${prior.length + 1}` : base
    const item = await this.deps.stores.attention.create({
      requestId, runId: this.state.runId, nodeId: ns.id, requirementId: this.state.requirementId, ask, form, choices,
    })
    if (this.signal.aborted) {
      const answered = await this.deps.stores.attention.answer(item.requestId, { decision: 'cancelled', by: system })
      await this.emit('human.requested', { requestId, ask, form, choices }, ns.id)
      await this.recordAnswer(answered)
      this.signal.throwIfAborted()
    }
    this.requests[ns.id] = requestId
    ns.status = 'waiting_human'
    await this.persistGraph()
    await this.emit('human.requested', { requestId, ask, form, choices }, ns.id)
    if (this.signal.aborted) {
      const answered = await this.deps.stores.attention.answer(item.requestId, { decision: 'cancelled', by: system })
      await this.recordAnswer(answered)
      this.signal.throwIfAborted()
    }
    if (autoApprove && this.options.autoApprove) {
      const actor: Actor = { type: 'human', id: 'auto-approve' }
      const answered = await this.deps.stores.attention.answer(item.requestId, {
        decision: 'approve', answer: form === 'answer' ? '（自动通过）' : undefined, by: actor,
      })
      await this.consume(entry, answered, actor)
    }
  }
  async schedule(ids: string[]): Promise<void> {
    const running = new Map<string, Promise<void>>()
    while (!this.signal.aborted) {
      for (const id of ids) {
        const ns = this.state.nodes[id]!
        if (ns.status !== 'pending' || running.has(id)) continue
        const entry = this.graph.get(id)!
        if (!(entry.def.needs ?? []).every((dep) => this.state.nodes[dep] && done(this.state.nodes[dep]!))) continue
        const task = this.runNode(entry)
        running.set(id, task)
      }
      if (!running.size) break
      const result = await Promise.race([...running].map(async ([id, task]) => { await task; return id }))
      running.delete(result)
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
    ns.endedAt = this.timestamp()
    await this.emit('node.failed', { error: ns.error, attempt: ns.attempts }, ns.id)
  }
  private async runNode(entry: Entry): Promise<void> {
    this.state.nodes[entry.def.id]!.status = 'ready'
    await this.emit('node.ready', {}, entry.def.id)
    if (entry.def.kind === 'loop' || entry.def.kind === 'planner') await this.runAttempts(entry)
    else await this.semaphore.use(() => this.runAttempts(entry))
  }
  private async runAttempts(entry: Entry): Promise<void> {
    const node = entry.def
    const ns = this.state.nodes[node.id]!
    for (let retry = 0; retry <= (node.retry?.max ?? 0); retry++) {
      if (this.signal.aborted) { ns.status = 'cancelled'; await this.save(); return }
      if (retry > 0) {
        ns.status = 'ready'
        await this.emit('node.ready', {}, node.id)
      }
      try {
        this.signal.throwIfAborted()
        const ctx = this.context(entry)
        if (node.when && !await node.when(ctx)) {
          ns.status = 'skipped'
          ns.endedAt = this.timestamp()
          await this.emit('node.finished', { status: 'skipped', outputs: [] }, node.id)
          return
        }
        ns.status = 'running'
        ns.attempts++
        ns.startedAt = this.timestamp()
        delete ns.endedAt
        await this.emit('node.started', { attempt: ns.attempts, iteration: ns.iteration }, node.id)
        ns.inputs = await resolveInputs(this.deps.stores, this.state, node, this.emit)
        await this.save()
        const actor = await this.execute(entry, ctx)
        await this.flushLogs()
        if (ns.status === 'running') await this.finish(entry, actor)
        return
      } catch (error) {
        await this.flushLogs()
        await this.fail(ns, error)
        if (this.state.nodes[node.id]!.status !== 'failed' || retry === (node.retry?.max ?? 0)) return
      }
    }
  }
  private environment(ctx: NodeContext): Record<string, string> {
    return { TAKT_RUN_ID: ctx.runId, TAKT_REQ: ctx.requirementId, TAKT_WORKSPACE: ctx.workspaceDir, TAKT_NODE: ctx.nodeId }
  }
  private async shell(text: string, ctx: NodeContext, timeoutMs?: number): Promise<{ code: number; output: string }> {
    this.signal.throwIfAborted()
    const signal = timeoutMs ? AbortSignal.any([this.signal, AbortSignal.timeout(timeoutMs)]) : this.signal
    const result = await command(text, ctx.projectDir, this.environment(ctx), signal)
    await this.emit('log', { level: result.code ? 'error' : 'info', message: result.output }, ctx.nodeId)
    return result
  }
  private async model(entry: Entry, ctx: NodeContext, role: string, prompt: string | AgentNodeDef['prompt'], schema: Record<string, unknown>): Promise<unknown> {
    const node = entry.def
    const result = await callHarness(this, {
      ...node, kind: 'agent', role, prompt, resultSchema: schema,
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
          const result = await node.run(ctx)
          if (result?.status === 'blocked') throw new BlockedError(result.message ?? '脚本被阻塞')
          if (result?.status === 'failed') throw new Error(result.message ?? '脚本失败')
          ns.result = result?.data
        }
        break
      }
      case 'agent': {
        const result = await callHarness(this, node, ctx, ns, false)
        ns.result = result.data
        return result.actor
      }
      case 'human': await this.request(entry, node.ask, node.form, node.choices, true); break
      case 'gate': {
        const checks: GateCheckResult[] = []
        for (const check of node.checks) {
          try {
            if (check.kind === 'command') {
              const result = await this.shell(check.run, ctx, node.timeoutMs)
              checks.push({ id: check.id, pass: result.code === 0, message: result.output })
            } else if (check.kind === 'function') {
              this.signal.throwIfAborted()
              const result = await check.fn(ctx)
              checks.push({ ...result, id: check.id, pass: result.pass === true })
            } else {
              const value = await this.model(entry, ctx, check.role, `按以下 rubric 检查并输出 score、pass、message：\n${check.rubric}`, objectSchema({ score: { type: 'number' }, pass: { type: 'boolean' }, message: { type: 'string' } })) as GateCheckResult
              checks.push({ ...value, id: check.id, pass: value.pass && value.score! >= check.threshold })
            }
          } catch (error) {
            if (error instanceof BlockedError) throw error
            checks.push({ id: check.id, pass: false, message: errorText(error) })
          }
        }
        this.signal.throwIfAborted()
        const pass = checks.every((check) => check.pass)
        ns.result = { pass, checks }
        await this.emit('gate.result', { pass, checks }, node.id)
        if (!pass) {
          if (node.onFail === 'human') await this.request(entry, `门禁未通过，请裁决：${JSON.stringify(checks.filter((c) => !c.pass))}`, 'approve', undefined, true)
          else throw new Error(`门禁未通过：${checks.filter((check) => !check.pass).map((check) => `${check.id}: ${check.message ?? '失败'}`).join('; ')}`)
        }
        break
      }
      case 'judge': await this.judge(entry, node, ctx); break
      case 'loop': await this.loop(entry); break
      case 'planner': {
        let expansion = this.state.expansions.find((item) => item.plannerId === node.id)
        if (!expansion) {
          const value = await this.model(entry, ctx, node.role, node.prompt, objectSchema({ items: { type: 'array', items: objectSchema({
            key: { type: 'string' }, title: { type: 'string' }, role: { type: 'string' },
            dependsOn: { type: 'array', items: { type: 'string' } }, params: { type: 'object' },
          }, ['key', 'title']) } })) as { items: PlannedItem[] }
          const groups = expandPlanner(node, value.items)
          const ids = groups.flatMap((group) => group.nodes.map((child) => child.id))
          if (ids.some((id) => this.graph.has(id))) throw new Error('planner 展开节点 ID 冲突')
          for (const group of groups) this.add(group.nodes, node.id, group.scope, group.item, entry.iteration)
          expansion = { plannerId: node.id, items: value.items, nodeIds: ids, at: this.timestamp() }
          this.state.expansions.push(expansion)
          await this.persistGraph()
          await this.emit('dag.expanded', expansion, node.id)
        }
        await this.schedule(expansion.nodeIds)
        this.containerState(ns, expansion.nodeIds)
        await this.save()
        break
      }
      case 'subflow': throw new Error('not implemented')
    }
    return system
  }
  private containerState(ns: NodeState, ids: string[]): void {
    this.signal.throwIfAborted()
    if (ids.every((id) => done(this.state.nodes[id]!))) return
    if (ids.some((id) => this.state.nodes[id]!.status === 'waiting_human')) ns.status = 'waiting_human'
    else throw new Error(`子 DAG 未完成：${ids.filter((id) => !done(this.state.nodes[id]!)).join(', ')}`)
  }
  private async loop(entry: Entry): Promise<void> {
    const node = entry.def
    if (node.kind !== 'loop') return
    if (!Number.isInteger(node.maxIterations) || node.maxIterations < 1) throw new Error('maxIterations 必须是正整数')
    const ns = this.state.nodes[node.id]!
    if (ns.iteration === undefined) {
      ns.iteration = 1
      this.addLoop(entry, 1)
      await this.persistGraph()
      await this.save()
    }
    for (;;) {
      const ids = node.body.map((child) => `${node.id}/${child.id}`)
      await this.schedule(ids)
      this.containerState(ns, ids)
      if (ns.status === 'waiting_human') { await this.save(); return }
      if (await node.until(this.context(entry, true))) return
      if (ns.iteration! >= node.maxIterations) {
        if ((node.onExhausted ?? 'human') === 'human') await this.request(entry, `循环 ${node.title} 已达到 ${node.maxIterations} 轮，是否放行？`, 'approve')
        else throw new Error(`循环达到 maxIterations=${node.maxIterations}`)
        return
      }
      for (const id of [...this.graph.keys()]) if (id.startsWith(`${node.id}/`)) {
        this.graph.delete(id)
        delete this.state.nodes[id]
        delete this.requests[id]
      }
      this.state.expansions = this.state.expansions.filter((expansion) => !expansion.plannerId.startsWith(`${node.id}/`))
      ns.iteration!++
      this.addLoop(entry, ns.iteration!)
      await this.persistGraph()
      await this.save()
    }
  }
  private async judge(entry: Entry, node: JudgeNodeDef, ctx: NodeContext): Promise<void> {
    const target = ctx.resultOf(node.target) as { failures?: Array<{ subject: string }> } | undefined
    const failures = target?.failures ?? []
    if (!Array.isArray(failures)) throw new Error('judge target.failures 必须是数组')
    let verdicts: JudgeVerdict[] = []
    if (failures.length) {
      const value = await this.model(entry, ctx, node.role, `判断以下失败的根因。输出 { verdicts: JudgeVerdict[] }，每个 subject 恰好一个判决：\n${JSON.stringify(failures)}`, objectSchema({ verdicts: {
        type: 'array', items: objectSchema({ subject: { type: 'string' }, category: { type: 'string', enum: ['product_bug', 'case_defect', 'script_defect', 'env_issue', 'flaky', 'requirement_gap', 'unknown'] },
          confidence: { type: 'number' }, rationale: { type: 'string' }, evidence: { type: 'array', items: { type: 'string' } },
          fixScope: { type: 'string', enum: ['mechanical', 'semantic'] }, fixHint: { type: 'string' },
        }, ['subject', 'category', 'confidence', 'rationale', 'evidence']),
      } })) as { verdicts: JudgeVerdict[] }
      verdicts = value.verdicts
      if (verdicts.length !== failures.length || new Set(verdicts.map((v) => v.subject)).size !== failures.length || verdicts.some((v) => !failures.some((f) => f.subject === v.subject))) throw new Error('judge 判决没有逐项覆盖失败 subject')
    }
    const routed: Record<string, string[]> = {}
    const routing: Array<{ subject: string; to: string }> = []
    let needsHuman = false
    for (const verdict of verdicts) {
      const to = node.routes[verdict.category] ?? 'human'
      routing.push({ subject: verdict.subject, to })
      if (to === 'human') needsHuman = true
      else if (to !== 'ignore') (routed[to] ??= []).push(verdict.subject)
    }
    for (const target of new Set(Object.values(node.routes))) {
      if (target === 'human' || target === 'ignore') continue
      const id = this.graph.has(entry.scope + target) ? entry.scope + target : target
      const child = this.graph.get(id)
      if (!child || !child.def.needs?.includes(node.id)) throw new Error(`判决路由目标必须依赖本节点：${target}`)
      if (!routed[target]?.length && this.state.nodes[id]!.status === 'pending') {
        this.state.nodes[id]!.status = 'skipped'
        this.state.nodes[id]!.endedAt = this.timestamp()
        await this.emit('node.finished', { status: 'skipped', outputs: [] }, id)
      }
    }
    const ns = this.state.nodes[node.id]!
    ns.result = { verdicts, routed }
    // 没有失败就没有判决：不记 judge.verdict、不写判决产物（docs/dev/core-engine.md 的 judge 约定）
    if (!failures.length) return
    await this.emit('judge.verdict', { verdicts, routed: routing }, node.id)
    const path = `reports/verdicts/${this.state.runId}-${node.id}-${entry.iteration ?? 0}.json`
    const content = JSON.stringify(ns.result, null, 2)
    const ref = await this.deps.stores.workspaces.writeArtifact({
      ref: { workspace: this.state.requirementId, path }, kind: 'verdict', content, author: system,
      derivedFrom: ns.inputs ?? [], producedBy: { runId: this.state.runId, nodeId: node.id }, reason: node.title,
    })
    ns.outputs.push(ref)
    await this.emit('artifact.written', { ref, kind: 'verdict', sha256: sha256(content) }, node.id)
    if (needsHuman) await this.request(entry, `失败判决需要人工裁决：${JSON.stringify(verdicts.filter((v) => (node.routes[v.category] ?? 'human') === 'human'))}`, 'approve')
  }
  async run(): Promise<RunState> {
    if (!this.signal.aborted) {
      this.state.status = 'running'
      delete this.state.endedAt
    }
    await this.save()
    await this.schedule(this.workflow.nodes.map((node) => node.id))
    await this.flushLogs()
    if (this.signal.aborted) this.state.status = 'cancelled'
    else if (Object.values(this.state.nodes).some((node) => node.status === 'waiting_human')) this.state.status = 'waiting_human'
    else if (this.workflow.nodes.every((node) => done(this.state.nodes[node.id]!))) this.state.status = 'succeeded'
    else this.state.status = 'failed'
    this.state.endedAt = this.timestamp()
    await this.emit('run.finished', { status: this.state.status })
    return structuredClone(this.state)
  }
}
