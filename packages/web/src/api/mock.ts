import type {
  Actor,
  ArtifactRecord,
  EvalSampleRequest,
  EventEnvelope,
  EventPayloads,
  EventType,
  GraphNode,
  JudgeVerdict,
  NodeDetail,
  RequirementSummary,
  RunSummary,
  StageProgress,
  StageStatus,
  Usage,
} from '@taktflow/core'
import { createMockChat } from './mock-chat'
import { MOCK_COMMANDS, runMockCommand } from './mock-commands'
import { createMockEval, mockRecipe } from './mock-eval'
import { createMockLessons } from './mock-lessons'
import { attentionView, budgetStatus, decorateAttentions, enrichM3, qualityOf, sumQuality } from './mock-m3-runs'
import { previewRoute } from './mock-route'
import { addUsage, ZERO, type MockDb, type MockRun } from './mock-data'
import { mockDaily, mockHistory } from './mock-history'
import { totalTokens } from '../lib/format'
import { createMockReviews } from './mock-reviews'
import type { WorkflowApi } from './mock-workflows'
import { createMockRequirementCrud } from './mock-crud'
import { createMockChanges, mockActivity, mockTimeline } from './mock-m5-run'
import { createMockChecks } from './mock-m5-checks'
import { createMockQuality } from './mock-m5-quality'
import { createMockRuntime } from './mock-m6-runtime'
import { RewindConflictError } from './source-m5'
import type { DataSource } from './source'
import type { KnowledgeSource, StewardSource } from './source-m4'
import type { M8Source } from './source-m8'

/** 单个空间的演示数据源；空间级接口（spaces / space / 技能文件…）由 mock-source.ts 包一层。 */
export type ProjectSource = Omit<
  DataSource,
  'me' | 'spaces' | 'space' | 'setMembers' | 'addRepo' | 'updateRepo' | 'syncRepo' | 'spaceFile' | 'saveSpaceFile' | keyof WorkflowApi | keyof StewardSource | keyof KnowledgeSource | 'serverInfo' | 'createSpace' | 'updateSpace' | 'archiveSpace' | 'restoreSpace' | 'deleteSpace' | 'convertWorkflow' | 'routePreviewDraft' | 'forSpace' | keyof M8Source
>

const clone = <T,>(v: T): T => structuredClone(v)
const LOADED = Date.now()

/** 演示数据源：实现与 HTTP 客户端相同的接口，状态保存在内存里（刷新即复位）。 */
export function createProjectMock(db: MockDb): ProjectSource {
  enrichM3(db)
  const chat = createMockChat(db)
  const reviews = createMockReviews(db)
  decorateAttentions(db)
  const lessons = createMockLessons(db.requirements.length > 0)
  const evals = createMockEval(db.requirements.length > 0, (reqId) => [...db.runs.values()].filter((r) => r.state.requirementId === reqId).sort((a, b) => b.state.startedAt.localeCompare(a.state.startedAt))[0]?.state.runId)
  const delay = <T,>(v: T, ms = 90): Promise<T> => new Promise((r) => setTimeout(() => r(clone(v)), ms))
  const fail = (msg: string) => Promise.reject(new Error(msg))
  const checks = createMockChecks(db)
  const quality = createMockQuality(db)
  const runtime = createMockRuntime(db.requirements.length > 0)
  // 回退：本节点与下游标 stale，存放区产物写回退点版本（不删历史），记 node.rewound
  const changes = createMockChanges(db, (run, nodeId, p, reason) => {
    const actor: Actor = { type: 'human', id: 'web' }
    for (const f of p.files) {
      if (f.scope !== 'workspace' || !f.from) continue
      const rec = db.artifacts.get(run.state.requirementId)?.find((a) => a.path === f.path)
      const back = db.contents.get(`${run.state.requirementId}:${f.path}@${f.from}`)
      if (!rec || !back) continue
      const last = rec.versions[rec.versions.length - 1]!
      const version = last.version + 1
      rec.versions.push({ ...last, version, createdAt: new Date().toISOString(), author: actor, reason: `回退到「${nodeId}」之前：${reason}`, derivedFrom: [{ workspace: run.state.requirementId, path: f.path, version: f.from }], producedBy: undefined })
      db.contents.set(`${run.state.requirementId}:${f.path}@${version}`, back)
    }
    for (const s of p.stale) {
      const g = run.graph.nodes.find((n) => n.id === s.nodeId)
      if (!g) continue
      g.status = 'stale'
      run.state.nodes[s.nodeId]!.status = 'stale'
    }
    appendEvent(run, 'node.rewound', actor, { reason, files: p.files.map((f) => ({ path: f.path, scope: f.scope, repo: f.repo, version: f.from })), stale: p.stale.map((s) => ({ runId: s.runId, nodeId: s.nodeId })) }, nodeId)
  })

  /** 运行中的节点：token 随时间缓慢增长，模拟实时进度。 */
  function liveUsage(run: MockRun, id: string, u: Usage | undefined): Usage | undefined {
    if (!run.live.includes(id)) return u
    const sec = (Date.now() - LOADED) / 1000
    return addUsage(u ?? ZERO, { inputTokens: Math.round(sec * 140), outputTokens: Math.round(sec * 18), cachedTokens: Math.round(sec * 50), costUsd: sec * 0.0007 })
  }

  function graphNodes(run: MockRun): GraphNode[] {
    return run.graph.nodes.map((n) => ({ ...n, usage: liveUsage(run, n.id, n.usage), activity: n.status === 'running' && run.live.includes(n.id) && (n.kind === 'agent' || n.kind === 'judge') ? mockActivity(n.id) : undefined }))
  }

  function runUsage(run: MockRun): Usage {
    return graphNodes(run).reduce<Usage>((acc, n) => addUsage(acc, n.usage), ZERO)
  }

  /** 与 core 的 stageProgress（insights/graph.ts）同一套规则：演示数据扮演 server，web 页面本身不再推导。 */
  function stageProgress(run: MockRun | undefined): StageProgress[] {
    if (!run) return []
    return run.workflow.stages.map((s) => {
      const ns = run.graph.nodes.filter((n) => n.stage === s.id)
      const done = ns.filter((n) => n.status === 'succeeded' || n.status === 'skipped').length
      const has = (...st: GraphNode['status'][]) => ns.some((n) => st.includes(n.status))
      let status: StageStatus = 'todo'
      if (has('failed', 'blocked', 'cancelled')) status = 'failed'
      else if (has('waiting_human')) status = 'waiting_human'
      else if (ns.length > 0 && done === ns.length) status = 'done'
      else if (done > 0 || has('running', 'ready', 'stale')) status = 'running'
      return { ...s, status, done, total: ns.length }
    })
  }

  function runsOf(reqId: string): MockRun[] {
    return [...db.runs.values()].filter((r) => r.state.requirementId === reqId).sort((a, b) => Date.parse(b.state.startedAt) - Date.parse(a.state.startedAt))
  }

  // 演示"运行中断"：?mock=1&interrupted=<runId> 把一个 running 的运行当作没有进程在执行；run.resume 后恢复
  const interrupted = new Set(typeof location === 'undefined' ? [] : new URLSearchParams(location.search).getAll('interrupted'))
  // 演示"运行失败"：?mock=1&failed=<runId> 把正在跑的节点标成失败；run.retry 把它们放回运行中
  const demoFailed = new Map<string, string[]>()
  for (const id of typeof location === 'undefined' ? [] : new URLSearchParams(location.search).getAll('failed')) {
    const run = db.runs.get(id)
    if (!run || run.state.status === 'succeeded' || run.state.status === 'cancelled') continue
    const nodes = Object.values(run.state.nodes).filter((n) => n.status === 'running')
    for (const n of nodes) Object.assign(n, { status: 'failed', error: '作者回应必须与本轮问题逐条对应：["architect","ISS-36"]' })
    run.state.status = 'failed'
    demoFailed.set(id, nodes.map((n) => n.id))
  }
  const isInterrupted = (run: MockRun) => (run.state.status === 'running' && interrupted.has(run.state.runId) ? { interrupted: true as const } : {})

  function runSummary(run: MockRun): RunSummary {
    const ns = run.graph.nodes
    return {
      runId: run.state.runId,
      workflowId: run.state.workflowId,
      requirementId: run.state.requirementId,
      status: run.state.status,
      startedAt: run.state.startedAt,
      endedAt: run.state.endedAt,
      progress: {
        done: ns.filter((n) => n.status === 'succeeded' || n.status === 'skipped').length,
        total: ns.length,
        failed: ns.filter((n) => n.status === 'failed' || n.status === 'blocked').length,
      },
      usage: runUsage(run),
      kind: run.state.kind,
      origin: run.state.origin,
      tier: run.state.route?.tier,
      ...isInterrupted(run),
    }
  }

  function summary(id: string): RequirementSummary {
    const req = db.requirements.find((r) => r.id === id)!
    const runs = runsOf(id)
    // 临时任务也是运行，但阶段条按需求的主流水线算
    const latest = runs.find((r) => r.state.workflowId !== 'task')
    const stages = stageProgress(latest)
    const current = stages.find((s) => s.status !== 'done')?.id ?? stages[stages.length - 1]?.id
    // 当前节点：运行中的优先，其次等人的、被拦下的（与 server 读模型同一顺序）
    const pick = latest && (['running', 'waiting_human', 'blocked', 'failed'] as const).map((st) => latest.graph.nodes.find((n) => n.status === st && n.kind !== 'loop' && n.kind !== 'planner')).find(Boolean)
    return {
      ...req,
      stage: latest ? current : undefined,
      stages,
      latestRunId: latest?.state.runId,
      pendingAttention: db.attention.filter((a) => a.requirementId === id && !a.answeredAt).length,
      usage: runs.reduce<Usage>((acc, r) => addUsage(acc, runUsage(r)), ZERO),
      current: latest && pick ? { runId: latest.state.runId, nodeId: pick.id, title: pick.title, status: pick.status } : undefined,
      tier: latest?.state.route?.tier,
      quality: runs.length ? sumQuality(runs.map(qualityOf)) : undefined,
      recentRuns: [
        ...mockHistory(id),
        ...[...runs].reverse().map((r) => ({ runId: r.state.runId, status: r.state.status, startedAt: r.state.startedAt, tokens: totalTokens(runUsage(r)), kind: r.state.workflowId === 'task' || r.state.kind === 'task' ? ('task' as const) : ('workflow' as const) })),
      ].slice(-12),
    }
  }

  function appendEvent<T extends EventType>(run: MockRun, type: T, actor: Actor, data: EventPayloads[T], nodeId?: string): EventEnvelope {
    const prev = run.events[run.events.length - 1]
    const seq = (prev?.seq ?? 0) + 1
    const prevHash = prev?.hash ?? '0'.repeat(64)
    const e = { seq, ts: new Date().toISOString(), runId: run.state.runId, nodeId, type, actor, data, prevHash, hash: (prevHash.slice(8) + seq.toString(16).padStart(8, '0')).slice(-64) } as EventEnvelope
    run.events.push(e)
    return e
  }

  function getRun(runId: string): MockRun | undefined {
    return db.runs.get(runId)
  }

  return {
    mock: true,
    ...createMockRequirementCrud(db, summary, (id) => runsOf(id).length > 0),
    project() {
      const requirements = db.requirements.map((r) => summary(r.id))
      return delay({
        name: db.project.name,
        description: db.project.description,
        requirements,
        attention: db.attention.filter((a) => !a.answeredAt).map((a) => attentionView(db, a)),
        totals: {
          requirements: requirements.length,
          active: requirements.filter((r) => r.status === 'active').length,
          delivered: requirements.filter((r) => r.status === 'delivered').length,
          blocked: requirements.filter((r) => r.status === 'blocked').length,
          runs: db.runs.size,
          usage: requirements.reduce<Usage>((acc, r) => addUsage(acc, r.usage), ZERO),
          verified: requirements.reduce((s, r) => s + (r.quality?.verified ?? 0), 0),
          intercepted: requirements.reduce((s, r) => s + (r.quality?.intercepted ?? 0), 0),
          daily: mockDaily(requirements.flatMap((r) => r.recentRuns ?? [])),
        },
      })
    },
    requirements: () => delay(db.requirements.map((r) => summary(r.id))),
    requirement(id) {
      if (!db.requirements.some((r) => r.id === id)) return fail(`需求 ${id} 不存在`)
      return delay({ ...summary(id), artifacts: db.artifacts.get(id) ?? [], runs: runsOf(id).map(runSummary) })
    },
    artifacts: (id) => delay(db.artifacts.get(id) ?? []),
    artifact(id, path, version) {
      const rec = db.artifacts.get(id)?.find((a) => a.path === path)
      if (!rec) return fail(`产物 ${path} 不存在`)
      const ver = version ?? rec.versions[rec.versions.length - 1]!.version
      const c = db.contents.get(`${id}:${path}@${ver}`)
      if (!c) return fail(`产物 ${path}@v${ver} 不存在`)
      return delay({ path, version: ver, mediaType: c.mediaType, content: c.content, encoding: c.encoding ?? 'utf8' }, 60)
    },
    editArtifact(id, path, body) {
      if (!body.reason.trim()) return fail('reason 必填')
      const rec = db.artifacts.get(id)?.find((a) => a.path === path) as ArtifactRecord | undefined
      if (!rec) return fail(`产物 ${path} 不存在`)
      const last = rec.versions[rec.versions.length - 1]!
      const version = last.version + 1
      const author: Actor = { type: 'human', id: 'web' }
      rec.versions.push({ version, sha256: Math.random().toString(16).slice(2).padEnd(64, '0').slice(0, 64), size: body.content.length, createdAt: new Date().toISOString(), author, reason: body.reason, derivedFrom: [{ workspace: id, path, version: last.version }] })
      db.contents.set(`${id}:${path}@${version}`, { content: body.content, mediaType: rec.mediaType })

      // stale 传播：读过这个产物的节点及其下游
      const staleNodes: Array<{ runId: string; nodeId: string }> = []
      for (const run of runsOf(id)) {
        if (run.state.status === 'cancelled') continue
        const seeds = Object.values(run.state.nodes).filter((n) => n.inputs?.some((r) => r.path === path)).map((n) => n.id)
        const seen = new Set<string>()
        const queue = [...seeds]
        while (queue.length) {
          const cur = queue.shift()!
          if (seen.has(cur)) continue
          seen.add(cur)
          for (const e of run.graph.edges) if (e.from === cur) queue.push(e.to)
          for (const n of run.graph.nodes) if (n.parent === cur) queue.push(n.id)
        }
        appendEvent(run, 'artifact.edited', author, { ref: { workspace: id, path, version }, reason: body.reason, impact: body.impact })
        // 措辞调整只记录，不传播 stale（docs/design/19 §5）
        if (body.impact === 'cosmetic') continue
        for (const nodeId of seen) {
          const g = run.graph.nodes.find((n) => n.id === nodeId)
          if (!g || g.status !== 'succeeded') continue
          g.status = 'stale'
          run.state.nodes[nodeId]!.status = 'stale'
          appendEvent(run, 'node.stale', { type: 'system', id: 'server' }, { cause: { workspace: id, path, version } }, nodeId)
          staleNodes.push({ runId: run.state.runId, nodeId })
        }
      }
      return delay({ version, staleNodes }, 200)
    },
    comments: (id, path) => delay(db.comments.filter((c) => (path ? c.path === path : true) && (db.artifacts.get(id) ?? []).some((a) => a.path === c.path))),
    addComment(_id, body) {
      const c = { id: `c${db.comments.length + 1}`, path: body.path, version: body.version, author: { type: 'human' as const, id: 'web' }, body: body.body, createdAt: new Date().toISOString() }
      db.comments.push(c)
      return delay(c)
    },
    trace: (id) => delay(db.traces.get(id) ?? { nodes: [], edges: [] }),
    metrics(id) {
      const m = db.metrics.get(id)
      if (!m) return fail(`需求 ${id} 不存在`)
      const runs = runsOf(id)
      return delay({ ...m, runs: runs.length, usage: runs.reduce<Usage>((acc, r) => addUsage(acc, runUsage(r)), ZERO), quality: runs.length ? sumQuality(runs.map(qualityOf)) : undefined })
    },
    runs: (requirement) => delay((requirement ? runsOf(requirement) : [...db.runs.values()]).map(runSummary)),
    run(runId) {
      const run = getRun(runId)
      if (!run) return fail(`运行 ${runId} 不存在`)
      const usage = runUsage(run)
      return delay({ run: run.state, workflow: run.workflow, stages: stageProgress(run), usage, graph: { nodes: graphNodes(run), edges: run.graph.edges }, budget: budgetStatus(run, usage), quality: qualityOf(run), ...isInterrupted(run) })
    },
    events(runId, opts = {}) {
      const run = getRun(runId)
      if (!run) return fail(`运行 ${runId} 不存在`)
      const events = run.events.filter((e) => e.seq > (opts.after ?? 0) && (!opts.node || e.nodeId === opts.node) && (!opts.types || opts.types.includes(e.type)))
      return delay(opts.last === undefined ? events : events.slice(-opts.last))
    },
    node(runId, nodeId) {
      const run = getRun(runId)
      const t = run?.tpl.get(nodeId)
      const state = run?.state.nodes[nodeId]
      if (!run || !t || !state) return fail(`节点 ${nodeId} 不存在`)
      const events = run.events.filter((e) => e.nodeId === nodeId)
      const verdicts = events.filter((e) => e.type === 'judge.verdict').flatMap((e) => (e.data as { verdicts: JudgeVerdict[] }).verdicts)
      const gateEvent = [...events].reverse().find((e) => e.type === 'gate.result')
      const records = db.artifacts.get(run.state.requirementId) ?? []
      const detail: NodeDetail = {
        state: { ...state, usage: liveUsage(run, nodeId, state.usage) },
        kind: t.kind,
        title: t.title,
        stage: t.stage,
        role: t.role,
        prompt: run.prompts.get(nodeId) ?? t.prompt ?? t.ask,
        inputs: (state.inputs ?? []).map((r) => ({ path: r.path, version: r.version })),
        outputs: state.outputs.map((r) => ({ path: r.path, version: r.version ?? 1, kind: records.find((a) => a.path === r.path)?.kind ?? 'other' })),
        context: run.context.get(nodeId) ?? { snapshots: [], compactions: [] },
        verdicts: t.kind === 'judge' ? verdicts : undefined,
        gate: gateEvent ? (gateEvent.data as NodeDetail['gate']) : undefined,
        checks: t.checks,
        review: t.kind === 'review' ? reviews.detail(runId, nodeId) : undefined,
        goal: t.goal,
        summary: state.summary,
        completion: t.completion,
        completionChecks: state.checks,
        failures: state.failures,
        recipe: state.startedAt ? mockRecipe(nodeId, t.kind, t.role) : undefined,
        events,
      }
      checks.decorate(run, nodeId, detail)
      if (state.startedAt) detail.changes = changes.changes(run, nodeId)
      return delay(detail)
    },
    timeline(runId) {
      const run = getRun(runId)
      return run ? delay(mockTimeline(run), 140) : fail(`运行 ${runId} 不存在`)
    },
    nodeChanges(runId, nodeId) {
      const run = getRun(runId)
      return run?.state.nodes[nodeId] ? delay(changes.changes(run, nodeId)) : fail(`节点 ${nodeId} 不存在`)
    },
    nodeDiff(runId, nodeId, path) {
      const run = getRun(runId)
      return run ? delay({ patch: changes.diff(run, nodeId, path) }, 80) : fail(`运行 ${runId} 不存在`)
    },
    rewindPreview(runId, nodeId) {
      const run = getRun(runId)
      return run?.state.nodes[nodeId] ? delay(changes.preview(run, nodeId), 260) : fail(`节点 ${nodeId} 不存在`)
    },
    rewind(runId, nodeId, body) {
      const run = getRun(runId)
      if (!run) return fail(`运行 ${runId} 不存在`)
      const r = changes.rewind(run, nodeId, body.token, body.reason)
      if (r === 'conflict') return new Promise((_, reject) => setTimeout(() => reject(new RewindConflictError('预览之后工作树多了一次提交，已按最新状态重新预览')), 320))
      if (typeof r === 'string') return fail(r)
      return delay({ files: r.files, stale: r.stale }, 420)
    },
    snapshot(runId, checkpointId) {
      const run = getRun(runId)
      const m = run && checks.snapshot(run, checkpointId)
      return m ? delay(m) : fail(`检查点 ${checkpointId} 没有快照`)
    },
    snapshotFile(runId, checkpointId, path) {
      const run = getRun(runId)
      const f = run && checks.snapshotFile(run, checkpointId, path)
      return f ? delay(f, 60) : fail(`快照里没有 ${path}`)
    },
    ...quality,
    audit(runId) {
      const run = getRun(runId)
      if (!run) return fail(`运行 ${runId} 不存在`)
      return delay({ ok: true })
    },
    attention: (pending) => delay(db.attention.filter((a) => (pending ? !a.answeredAt : true)).sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)).map((a) => attentionView(db, a))),
    answer(requestId, body) {
      const item = db.attention.find((a) => a.requestId === requestId)
      if (!item) return fail(`待办 ${requestId} 不存在`)
      // 和 server / CLI 的校验保持一致：已处理的不能再答；choice 编码为 decision='choice'、answer=选项原文
      if (item.answeredAt) return fail(`待办 ${requestId} 已处理`)
      if (item.form === 'choice' && (body.decision !== 'choice' || !body.answer || !item.choices?.includes(body.answer))) return fail(`选项不在 ${(item.choices ?? []).join(' / ')} 之中`)
      // 审批绑定回答时看到的版本：boundTo 刷新为各产物的最新版本
      const boundTo = item.boundTo?.map((r) => {
        const rec = db.artifacts.get(r.workspace)?.find((a) => a.path === r.path)
        return { ...r, version: rec?.versions[rec.versions.length - 1]?.version ?? r.version }
      })
      Object.assign(item, { answeredAt: new Date().toISOString(), answeredBy: { type: 'human', id: 'web' }, decision: body.decision, answer: body.answer, boundTo })
      const run = getRun(item.runId)
      if (run && item.kind === 'assumption') {
        // 待确认假设：确认 = 回答与假设相同；改答让这个节点过期（真实后端还会沿依赖传播）
        if (body.answer !== item.assumption) {
          const g = run.graph.nodes.find((n) => n.id === item.nodeId)
          if (g) g.status = 'stale'
          if (run.state.nodes[item.nodeId]) run.state.nodes[item.nodeId]!.status = 'stale'
          appendEvent(run, 'log', { type: 'human', id: 'web' }, { level: 'info', message: `人工改答假设：${body.answer ?? ''}；依赖节点已过期，请恢复运行` }, item.nodeId)
        }
      } else if (run) {
        appendEvent(run, 'human.answered', { type: 'human', id: 'web' }, { requestId, decision: body.decision, answer: body.answer, boundTo }, item.nodeId)
        const g = run.graph.nodes.find((n) => n.id === item.nodeId)
        if (g && g.status === 'waiting_human' && body.decision !== 'reject') {
          g.status = 'succeeded'
          run.state.nodes[item.nodeId]!.status = 'succeeded'
        }
      }
      chat.onAnswered(item)
      return delay(attentionView(db, item), 160)
    },
    harnesses: () => delay(runtime.harnesses(), 140),
    models: () => delay(runtime.models(), 140),
    pairings: () => delay(runtime.pairings(), 140),
    runtimeConfig: runtime.runtimeConfig,
    patchRuntime: runtime.patchRuntime,
    testRuntime: runtime.testRuntime,
    putSecret: runtime.putSecret,
    deleteSecret: runtime.deleteSecret,
    resendRoomTask(id, messageId, reason) {
      const r = chat.resendTask(id, messageId, reason)
      return typeof r === 'string' ? fail(r) : delay(r, 260)
    },
    room(id) {
      const room = chat.room(id)
      return room ? delay(room, 60) : fail(`需求 ${id} 不存在`)
    },
    addRoomMembers(id, members) {
      const room = chat.addMembers(id, members)
      return room ? delay(room) : fail(`需求 ${id} 不存在`)
    },
    chat(id, opts) {
      const list = chat.list(id, opts)
      return list ? delay(list, 120) : fail(`需求 ${id} 不存在`)
    },
    postChat(id, body) {
      if (!body.text.trim()) return fail('消息不能为空')
      const m = chat.post(id, body, { type: 'human', id: 'web' })
      return m ? delay(m, 60) : fail(`需求 ${id} 不存在`)
    },
    subscribeChat: (id, on, onLead) => chat.subscribe(id, on, onLead),
    requirementReviews: (id) => (db.requirements.some((r) => r.id === id) ? delay(reviews.list(id), 100) : fail(`需求 ${id} 不存在`)),
    disposeReview(runId, nodeId, body) {
      const d = reviews.dispose(runId, nodeId, body)
      return typeof d === 'string' ? fail(d) : delay(d, 140)
    },
    routePreview(id, body) {
      const r = previewRoute(db, id, body)
      return typeof r === 'string' ? fail(r) : delay(r, 380)
    },
    commands: () => delay(MOCK_COMMANDS, 60),
    runCommand(id, body) {
      const viaRun = (fn: () => Promise<unknown>, message: string) => fn().then((result) => ({ ok: true, message, result }))
      return delay(null, 120).then(() =>
        runMockCommand(id, body, {
          // 与真实命令同形：改档放在 override（见 core/commands/schema.ts）
          'route.preview': (i) => {
            const o = i.override as { tier?: string; reason?: string } | undefined
            return viaRun(() => this.routePreview(String(i.requirementId), { hint: i.hint as string | undefined, tier: o?.tier as never, reason: o?.reason }), '路由预览已执行')
          },
          'review.dispose': (i, reason) => viaRun(() => this.disposeReview(String(i.runId), String(i.nodeId), { groupKey: String(i.groupKey), state: i.state as never, reason: reason! }), '处置评审问题已执行'),
          'lesson.status': (i, reason) => viaRun(() => this.updateLesson(String(i.id), { status: i.status as never, reason: reason! }), '修改经验状态已执行'),
          'lesson.update': (i, reason) => viaRun(() => this.updateLesson(String(i.id), { title: i.title as never, body: i.body as never, status: i.status as never, trigger: i.trigger as never, reason: reason! }), '编辑经验已执行'),
          'lessons.list': (i) => viaRun(() => this.lessons(i.status as never), '经验列表已执行'),
          'attention.list': (i) => viaRun(() => this.attention(Boolean(i.pending)).then((l) => (i.requirementId ? l.filter((a) => a.requirementId === i.requirementId) : l)), '待办列表已执行'),
          'requirement.status': (i) => viaRun(() => this.requirement(String(i.requirementId)), '需求状态已执行'),
          'run.status': (i) => viaRun(() => this.run(String(i.runId)), '运行状态已执行'),
          'run.retry': (i) =>
            viaRun(async () => {
              const run = db.runs.get(String(i.runId))
              const ids = demoFailed.get(String(i.runId))
              if (!run || !ids) throw new Error('没有失败或阻塞的节点可以重试')
              for (const id of ids) Object.assign(run.state.nodes[id]!, { status: 'running', error: undefined })
              run.state.status = 'running'
              demoFailed.delete(String(i.runId))
              return { runId: i.runId, nodeIds: ids }
            }, '重试已开始'),
          'run.resume': (i) => viaRun(async () => (interrupted.delete(String(i.runId)) ? { runId: i.runId } : Promise.reject(new Error('运行仍在执行'))), '继续运行已执行'),
          'attention.answer': (i) => viaRun(() => this.answer(String(i.requestId), { decision: i.decision as string, answer: i.answer as string | undefined }), '回答待办已执行'),
          'eval.scorecards': (i) => viaRun(() => this.scorecards((i.by as never) ?? 'node', i.workflowId as string | undefined), '查询评测成绩单已执行'),
          'defect.report': (i) => viaRun(() => this.reportDefect(String(i.requirementId), i as never), '录入逃逸缺陷已执行'),
          'defect.attribute': (i) => viaRun(() => this.attributeDefect(String(i.requirementId), String(i.defectId)), '生成候选归因已执行'),
          'defect.confirm': (i, reason) => viaRun(() => this.confirmDefect(String(i.requirementId), String(i.defectId), { attribution: i.attribution as never, note: (i.note as string | undefined) ?? reason }), '人工确认归因已执行'),
          'eval.collect': (i) => viaRun(() => this.collectEvalCases(i as never), '收集评测用例已执行'),
          'eval.run': (i) => viaRun(() => this.startEvalRun(i as never), '启动回放评测已执行'),
          // M5 归因可信度与质量日志（core/commands/eval-commands.ts）
          'defect.observations': (i) => viaRun(() => this.observations(String(i.requirementId), { source: i.source as string | undefined, run: i.runId as string | undefined }), '查询观察已执行'),
          'defect.update': (i, reason) =>
            viaRun(
              () => this.updateDefect(String(i.requirementId), String(i.defectId), { validity: i.validity as never, resolution: i.resolution as never, duplicateOf: i.duplicateOf as string | undefined, baseRevision: Number(i.baseRevision), reason: reason! }),
              '更新缺陷已执行',
            ),
          'defect.suggest-merges': (i) => viaRun(() => this.mergeSuggestions(String(i.requirementId)), '生成合并建议已执行'),
          'defect.merge': (i, reason) => viaRun(() => this.decideMerge(String(i.requirementId), String(i.suggestionId), { decision: i.decision as never, reason: reason! }), '决定合并建议已执行'),
          'defect.miss': (i, reason) =>
            viaRun(
              () => this.decideMiss(String(i.requirementId), String(i.defectId), String(i.checkpointId), { verdict: i.verdict as never, conditions: i.conditions as never, note: i.note as string | undefined, baseRevision: i.baseRevision as number | undefined, reason: reason! }),
              '逐检查点改判已执行',
            ),
          'eval.sample': (i, reason) => viaRun(() => this.createEvalSample({ ...(i as Omit<EvalSampleRequest, 'reason'>), reason: reason! }), '生成评测样本已执行'),
          'eval.retire': (i, reason) => viaRun(() => this.retireEvalSample(String(i.caseId), reason!), '退役评测样本已执行'),
          'quality.sync': (i, reason) => viaRun(() => this.syncQuality({ runId: i.runId as string | undefined, reason: reason! }), '补算质量日志已执行'),
          'quality.verify': () => viaRun(() => this.qualityStatus(), '验证质量日志已执行'),
          'quality.repair': (_, reason) => viaRun(() => this.repairQuality(reason!), '修复质量锚点已执行'),
        }),
      )
    },
    ...evals,
    lessons: (status) => delay(lessons.list(status), 100),
    updateLesson(id, body) {
      const l = lessons.update(id, body)
      return typeof l === 'string' ? fail(l) : delay(l, 160)
    },
    subscribe(runId, onEvent) {
      const run = getRun(runId)
      if (!run || run.live.length === 0) return () => {}
      const nodeId = run.live[run.live.length - 1]!
      const lines = [
        ['harness.tool_call', { tool: 'Read', input: 'evidence/TC-EXP-003/result.json', output: '{ "amount": "12.5", "expected": "12.50" }', ok: true }],
        ['harness.message', { role: 'assistant', text: 'TC-EXP-003 第 2 轮仍失败：fix-code 改了 CSV 写出，但导出接口仍走旧的格式化函数。' }],
        ['harness.tool_call', { tool: 'Grep', input: 'formatAmount', output: 'src/export/csv.ts:42\nsrc/orders/format.ts:7', ok: true }],
        ['harness.tool_call', { tool: 'Read', input: 'evidence/TC-EXP-007/dom.html', output: '<button data-testid="order-export-btn" hidden>', ok: true }],
      ] as const
      let i = 0
      const timer = setInterval(() => {
        const [type, data] = lines[i % lines.length]!
        i++
        const actor: Actor = { type: 'agent', role: 'judge', harness: 'claude-code', model: 'claude-sonnet-4.5' }
        onEvent(clone(appendEvent(run, type, actor, data as EventPayloads[typeof type], nodeId)))
      }, 2600)
      return () => clearInterval(timer)
    },
  }
}
