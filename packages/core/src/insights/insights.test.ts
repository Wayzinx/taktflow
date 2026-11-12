import { describe, expect, it, vi } from 'vitest'
import type { ProjectStores } from '../interfaces.js'
import type { ArtifactRecord, EventEnvelope, EventPayloads, EventType, NodeState, Requirement, RunState, SnapshotNode, WorkflowSnapshot } from '../types.js'
import { buildRunGraph, stageProgress } from './graph.js'
import { FsInsights, createInsights } from './fs-insights.js'
import { summarizeRun } from './run.js'
import { summarizeUsage } from './usage.js'

const actor = { type: 'system', id: 'test' } as const
const startedAt = '2026-11-04T00:00:00.000Z'
const requirement: Requirement = { id: 'REQ-001', title: '交付', status: 'active', links: [], createdAt: startedAt, updatedAt: startedAt }
const node = (id: string, patch: Partial<SnapshotNode> = {}): SnapshotNode => ({ id, title: id, kind: 'script', needs: [], ...patch })
const workflow = (nodes: SnapshotNode[] = []): WorkflowSnapshot => ({ id: 'test', title: '测试', version: '1', stages: [{ id: 'test', title: '测试' }, { id: 'empty', title: '空阶段' }], nodes })
const runtime = (id: string, patch: Partial<NodeState> = {}): NodeState => ({ id, status: 'pending', attempts: 0, outputs: [], ...patch })
const run = (patch: Partial<RunState> = {}): RunState => ({ runId: 'run-1', requirementId: requirement.id, workflowId: 'test', workflowVersion: '1', status: 'running', startedAt, args: {}, nodes: {}, expansions: [], ...patch })
const event = <T extends EventType>(seq: number, type: T, data: EventPayloads[T], nodeId?: string, runId = 'run-1'): EventEnvelope<T> => ({ seq, ts: startedAt, runId, nodeId, type, data, actor, hash: '', prevHash: '' })
const start = (seq: number, nodeId: string, iteration?: number, attempt = 1) => event(seq, 'node.started', { attempt, iteration }, nodeId)
const finish = (seq: number, nodeId: string, result?: unknown) => event(seq, 'node.finished', { status: 'succeeded', outputs: [], result }, nodeId)
const artifact = (path: string, kind: ArtifactRecord['kind'], traceIds: string[] = []): ArtifactRecord => ({
  path, kind, mediaType: 'text/plain', tags: [], traceIds,
  versions: [{ version: 1, sha256: 'sha', size: 1, createdAt: startedAt, author: actor, derivedFrom: [] }],
})

function stores(input: {
  runs?: RunState[]
  events?: Record<string, EventEnvelope[]>
  snapshots?: Record<string, WorkflowSnapshot>
  artifacts?: ArtifactRecord[]
  contents?: Record<string, string>
  requirement?: Requirement
} = {}): ProjectStores {
  return {
    projectDir: '/unused', taktDir: '/unused/.takt', config: { project: { name: 'test' }, workflows: [] },
    workspaces: {
      listRequirements: vi.fn(async () => [input.requirement ?? requirement]),
      getRequirement: vi.fn(async () => input.requirement ?? requirement),
      createRequirement: vi.fn(), updateRequirement: vi.fn(), dir: vi.fn(),
      listArtifacts: vi.fn(async () => input.artifacts ?? []),
      readArtifact: vi.fn(async (ref) => input.contents?.[ref.path] === undefined ? undefined : Buffer.from(input.contents[ref.path]!)),
      writeArtifact: vi.fn(), detectUntracked: vi.fn(), listComments: vi.fn(), addComment: vi.fn(),
    },
    runs: {
      create: vi.fn(), getWorkflow: vi.fn(async (id) => input.snapshots?.[id]), save: vi.fn(), get: vi.fn(),
      list: vi.fn(async (filter) => (input.runs ?? []).filter((state) => !filter?.requirementId || state.requirementId === filter.requirementId)),
      saveContext: vi.fn(), saveCompaction: vi.fn(), getContext: vi.fn(),
    },
    events: { append: vi.fn(), read: vi.fn(async (id) => input.events?.[id] ?? []), subscribe: vi.fn(), verify: vi.fn() },
    paths: { agents: '/unused/agents', workflows: '/unused/workflows', skills: '/unused/skills', knowledge: '/unused/knowledge', requirements: '/unused/requirements' },
    chat: { getRoom: vi.fn(), ensureRoom: vi.fn(), addMembers: vi.fn(), list: vi.fn(), post: vi.fn(), subscribe: vi.fn() },
    attention: { list: vi.fn(), create: vi.fn(), answer: vi.fn() },
  }
}

describe('buildRunGraph / stageProgress', () => {
  it('解析嵌套 loop 中的同名依赖和判决路由，忽略外部 human/ignore 路由', () => {
    const snapshot = workflow([
      node('run'),
      node('outer', { kind: 'loop', stage: 'test', body: [
        node('run'),
        node('inner', { kind: 'loop', needs: ['run'], body: [
          node('run'), node('judge', { kind: 'judge', needs: ['run'], routes: { product_bug: 'fix', env_issue: 'human', flaky: 'ignore' } }),
          node('fix', { kind: 'agent', role: 'dev', needs: ['judge', 'missing'] }),
          node('outer-ref', { needs: ['outer/run'] }),
        ] }),
      ] }),
    ])
    const state = run({ nodes: { 'outer/inner/fix': runtime('outer/inner/fix', { status: 'running', attempts: 2, iteration: 3, sessionRef: { harness: 'codex', sessionId: 'x' } }) } })
    const graph = buildRunGraph(snapshot, state)
    expect(graph.nodes.find((entry) => entry.id === 'outer/inner/fix')).toMatchObject({ kind: 'agent', role: 'dev', stage: 'test', parent: 'outer/inner', status: 'running', attempts: 2, iteration: 3, harness: 'codex' })
    expect(graph.edges).toEqual(expect.arrayContaining([
      { from: 'outer/run', to: 'outer/inner', kind: 'dep' },
      { from: 'outer/inner/run', to: 'outer/inner/judge', kind: 'dep' },
      { from: 'outer/inner/judge', to: 'outer/inner/fix', kind: 'route', label: 'product_bug' },
      { from: 'outer/run', to: 'outer/inner/outer-ref', kind: 'dep' },
    ]))
    const ids = new Set(graph.nodes.map((entry) => entry.id))
    expect(graph.edges.every((edge) => ids.has(edge.from) && ids.has(edge.to))).toBe(true)
    expect(graph.edges.some((edge) => edge.to === 'human' || edge.to === 'ignore')).toBe(false)
  })

  it('planner 在 loop 内与嵌套展开均保留 parent，不猜测类型、角色或依赖', () => {
    const snapshot = workflow([node('loop', { kind: 'loop', stage: 'test', body: [node('plan', { kind: 'planner' })] })])
    const state = run({
      expansions: [
        { plannerId: 'loop/plan/a/plan', nodeIds: ['loop/plan/a/plan/b/code'], items: [], at: startedAt },
        { plannerId: 'loop/plan', nodeIds: ['loop/plan/a/plan', 'loop/plan/a/review'], items: [{ key: 'a', title: '不能当成实际节点标题', role: 'dev', dependsOn: ['b'] }], at: startedAt },
        { plannerId: 'missing', nodeIds: ['missing/a/code'], items: [], at: startedAt },
      ],
    })
    const graph = buildRunGraph(snapshot, state)
    expect(graph.nodes.find((entry) => entry.id === 'loop/plan/a/plan/b/code')).toMatchObject({ kind: 'subflow', parent: 'loop/plan/a/plan', stage: 'test' })
    expect(graph.nodes.find((entry) => entry.id === 'loop/plan/a/review')).toMatchObject({ title: expect.stringContaining('定义未持久化') })
    expect(graph.nodes.find((entry) => entry.id === 'loop/plan/a/review')?.role).toBeUndefined()
    expect(graph.edges).toHaveLength(3)
    expect(graph.edges.every((edge) => edge.kind === 'expand')).toBe(true)
    expect(graph.nodes.some((entry) => entry.id === 'missing/a/code')).toBe(false)
  })

  it.each([
    ['pending', 'todo', 0], ['running', 'running', 0], ['ready', 'running', 0], ['stale', 'running', 0],
    ['succeeded', 'done', 1], ['skipped', 'done', 1], ['failed', 'failed', 0], ['blocked', 'failed', 0],
    ['cancelled', 'failed', 0], ['waiting_human', 'waiting_human', 0],
  ] as const)('阶段状态 %s → %s', (status, expected, done) => {
    const snapshot = workflow([node('a', { stage: 'test' })])
    const progress = stageProgress(snapshot, run({ nodes: { a: runtime('a', { status }) } }))
    expect(progress[0]).toMatchObject({ status: expected, done, total: 1 })
    expect(progress[1]).toMatchObject({ status: 'todo', total: 0, done: 0 })
  })

  it('阶段包含继承 stage 的 loop 子节点和 planner 展开节点，失败优先', () => {
    const snapshot = workflow([node('loop', { kind: 'loop', stage: 'test', body: [node('plan', { kind: 'planner' })] })])
    const state = run({ nodes: { loop: runtime('loop', { status: 'waiting_human' }), 'loop/plan/a': runtime('loop/plan/a', { status: 'failed' }) }, expansions: [{ plannerId: 'loop/plan', items: [], nodeIds: ['loop/plan/a'], at: startedAt }] })
    expect(stageProgress(snapshot, state)[0]).toMatchObject({ total: 3, done: 0, status: 'failed' })
  })
})

describe('summarizeUsage / summarizeRun', () => {
  it('按每次调用的 harness.usage 累计：重试、多轮、还在跑的调用都算，和预算同一口径', () => {
    const events = [
      start(1, 'a'), event(2, 'harness.usage', { inputTokens: 10, outputTokens: 2 }, 'a'),
      event(3, 'harness.usage', { inputTokens: 5, outputTokens: 3 }, 'a'),
      event(4, 'node.finished', { status: 'succeeded', outputs: [], usage: { inputTokens: 15, outputTokens: 5, cachedTokens: 4, costUsd: 0.1 } }, 'a'),
      start(5, 'b'), event(6, 'harness.usage', { inputTokens: 20, outputTokens: 4, costUsd: 0.2 }, 'b'),
      event(7, 'node.failed', { error: 'retry', attempt: 1 }, 'b'), start(8, 'b', undefined, 2),
      event(9, 'node.finished', { status: 'succeeded', outputs: [], usage: { inputTokens: 30, outputTokens: 6, costUsd: 0.3 } }, 'b'),
      start(10, 'a', 2), event(11, 'node.finished', { status: 'succeeded', outputs: [], usage: { inputTokens: 40, outputTokens: 8 } }, 'a'),
      event(12, 'harness.usage', { inputTokens: 7, outputTokens: 1 }),
    ]
    const before = JSON.stringify(events)
    expect(summarizeUsage([...events].reverse())).toEqual({ inputTokens: 42, outputTokens: 10, costUsd: expect.closeTo(0.2) })
    expect(JSON.stringify(events)).toBe(before)
  })

  it('按运行分别判断：没有 harness.usage 的旧运行退回结束事件', () => {
    const events = [
      event(1, 'harness.usage', { inputTokens: 10, outputTokens: 1 }, 'a', 'run-1'),
      event(1, 'node.finished', { status: 'succeeded', outputs: [], usage: { inputTokens: 20, outputTokens: 2 } }, 'a', 'run-2'),
      event(2, 'harness.usage', { inputTokens: 30, outputTokens: 3 }, 'b', 'run-1'),
    ]
    expect(summarizeUsage(events)).toEqual({ inputTokens: 60, outputTokens: 6 })
    expect(summarizeUsage([])).toEqual({ inputTokens: 0, outputTokens: 0 })
  })

  it('运行进度是调度状态汇总，跳过算完成但没有虚构业务通过率', () => {
    const state = run({ nodes: {
      a: runtime('a', { status: 'succeeded', usage: { inputTokens: 10, outputTokens: 4, costUsd: 0 } }),
      b: runtime('b', { status: 'skipped' }), c: runtime('c', { status: 'blocked' }), d: runtime('d', { status: 'stale' }),
    } })
    expect(summarizeRun(state)).toMatchObject({ progress: { total: 4, done: 2, failed: 1 }, usage: { inputTokens: 10, outputTokens: 4, costUsd: 0 } })
    expect(summarizeRun(run()).progress).toEqual({ total: 0, done: 0, failed: 0 })
  })
})

describe('FsInsights.metrics', () => {
  it('按每个 loop 首轮实际 total/failures 加权，重试和后续轮次不扩大分母', async () => {
    const snapshot = workflow(['one', 'two'].map((id) => node(id, { kind: 'loop', body: [node('run'), node('judge')] })))
    const events = [
      start(1, 'one/run', 1), finish(2, 'one/run', { failures: [{ subject: 'TC-1' }], total: 4 }),
      start(3, 'one/judge', 1), finish(4, 'one/judge', { verdicts: [] }),
      start(5, 'one/run', 1, 2), finish(6, 'one/run', { failures: [], total: 4 }),
      start(7, 'one/run', 2), finish(8, 'one/run', { failures: [], total: 4 }),
      start(9, 'two/run', 1), finish(10, 'two/run', { failures: [{ subject: 'TC-2' }], total: 1 }),
      event(11, 'judge.verdict', { verdicts: [{ subject: 'TC-2', category: 'product_bug', confidence: 1, rationale: 'bug', evidence: [] }, { subject: 'TC-3', category: 'unknown', confidence: 0, rationale: '?', evidence: [] }], routed: [{ subject: 'TC-2', to: 'fix' }, { subject: 'TC-3', to: 'human' }] }, 'two/judge'),
      event(12, 'human.answered', { requestId: 'answer', decision: 'approve' }, 'human'),
    ]
    const project = stores({ runs: [run(), run({ runId: 'other', requirementId: 'REQ-OTHER' })], snapshots: { 'run-1': snapshot }, events: { 'run-1': events } })
    const metrics = await new FsInsights(project).metrics(requirement.id)
    expect(metrics).toMatchObject({ runs: 1, firstPassRate: 3 / 5, loopIterations: 3, humanInterventions: 0, verdicts: { product_bug: 1, unknown: 1 } })
    expect(project.runs.list).toHaveBeenCalledWith({ requirementId: requirement.id })
    expect(project.workspaces.writeArtifact).not.toHaveBeenCalled()
  })

  it('多个运行独立加权，事件用量不与 state 再叠加', async () => {
    const project = stores({ runs: [run({ nodes: { a: runtime('a', { usage: { inputTokens: 999, outputTokens: 999 } }) } }), run({ runId: 'run-2' })], events: {
      'run-1': [start(1, 'loop/run', 1), event(2, 'harness.usage', { inputTokens: 40, outputTokens: 10 }, 'loop/run'), event(3, 'node.finished', { status: 'succeeded', outputs: [], result: { failures: [], total: 1 }, usage: { inputTokens: 40, outputTokens: 10 } }, 'loop/run')],
      'run-2': [event(1, 'node.started', { attempt: 1, iteration: 1 }, 'loop/run', 'run-2'), event(2, 'node.finished', { status: 'succeeded', outputs: [], result: { failures: [{ subject: 'TC-X' }], total: 3 } }, 'loop/run', 'run-2')],
    } })
    expect(await createInsights(project).metrics(requirement.id)).toMatchObject({ runs: 2, firstPassRate: 0.75, usage: { inputTokens: 40, outputTokens: 10 }, loopIterations: 0 })
  })

  it('嵌套 loop 每次外层调用分别计轮，内层首轮不会重复计首跑率', async () => {
    const snapshot = workflow([node('outer', { kind: 'loop', body: [node('inner', { kind: 'loop', body: [node('run')] })] })])
    const project = stores({ runs: [run()], snapshots: { 'run-1': snapshot }, events: { 'run-1': [
      start(1, 'outer/inner', 1), start(2, 'outer/inner/run', 1), finish(3, 'outer/inner/run', { failures: [{ subject: 'TC-X' }], total: 2 }),
      start(4, 'outer/inner/run', 2), finish(5, 'outer/inner/run', { failures: [], total: 2 }),
      start(6, 'outer/inner', 2), start(7, 'outer/inner/run', 1), finish(8, 'outer/inner/run', { failures: [], total: 2 }),
    ] } })
    expect(await new FsInsights(project).metrics(requirement.id)).toMatchObject({ firstPassRate: 0.5, loopIterations: 5 })
  })

  it('缺首轮开始、只有重试、无结论、无效 total 均不虚构首跑率', async () => {
    const project = stores({ runs: [run()], events: { 'run-1': [
      finish(1, 'missing', { failures: [], total: 1 }),
      start(2, 'retry', 1, 2), finish(3, 'retry', { failures: [], total: 1 }),
      start(4, 'empty', 1), finish(5, 'empty'), start(6, 'zero', 1), finish(7, 'zero', { failures: [], total: 0 }),
      start(8, 'bad', 1), finish(9, 'bad', { failures: ['a', 'b'], total: 1 }),
      start(10, 'negative', 1), finish(11, 'negative', { failures: [], total: -1 }),
    ] } })
    expect((await new FsInsights(project).metrics(requirement.id)).firstPassRate).toBeUndefined()
    expect(await new FsInsights(stores()).metrics(requirement.id)).toMatchObject({ runs: 0, loopIterations: 0, usage: { inputTokens: 0, outputTokens: 0 }, acCoverage: [] })
  })

  it('updatedAt 和运行 succeeded 都不是业务准出时间，不输出周期猜测', async () => {
    const delivered = { ...requirement, status: 'delivered' as const, updatedAt: '2026-11-04T02:00:00.000Z' }
    expect((await new FsInsights(stores({ requirement: delivered, runs: [run({ status: 'succeeded', endedAt: delivered.updatedAt })] })).metrics(requirement.id)).leadTimeHours).toBeUndefined()
    expect((await new FsInsights(stores()).metrics(requirement.id)).leadTimeHours).toBeUndefined()
  })

  it('交付周期 = 需求创建到最终阶段人工签字；没有人工节点时取最终阶段最后完成的节点；Lead 任务和未交付不算', async () => {
    const snapshot: WorkflowSnapshot = { id: 'test', title: '测试', version: '1', stages: [{ id: 'build', title: '开发' }, { id: 'report', title: '准出' }], nodes: [
      node('code', { stage: 'build' }), node('check', { kind: 'gate', stage: 'report' }), node('acceptance', { kind: 'human', stage: 'report', needs: ['check'] }), node('writeback', { kind: 'agent', stage: 'report', needs: ['acceptance'] }),
    ] }
    const done = (endedAt: string, result?: unknown) => runtime('', { status: 'succeeded', attempts: 1, endedAt, result })
    const nodes = { code: done('2026-11-04T01:00:00.000Z'), check: done('2026-11-04T02:00:00.000Z'), acceptance: done('2026-11-04T03:00:00.000Z', { decision: 'approve' }), writeback: done('2026-11-04T05:00:00.000Z') }
    const delivered = run({ status: 'succeeded', endedAt: '2026-11-04T05:00:00.000Z', nodes })
    const lead = run({ runId: 'task', kind: 'task', workflowId: 'lead', status: 'succeeded', startedAt: '2026-11-05T00:00:00.000Z' })
    const metrics = (runs: RunState[], snap = snapshot) => new FsInsights(stores({ runs, snapshots: { 'run-1': snap } })).metrics(requirement.id)
    expect((await metrics([delivered, lead])).leadTimeHours).toBe(3)
    const noHuman: WorkflowSnapshot = { ...snapshot, nodes: snapshot.nodes.filter((item) => item.id !== 'acceptance' && item.id !== 'writeback') }
    expect((await metrics([run({ status: 'succeeded', nodes: { code: nodes.code, check: nodes.check } })], noHuman)).leadTimeHours).toBe(2)
    expect((await metrics([run({ status: 'running', nodes: { ...nodes, acceptance: runtime('acceptance', { status: 'waiting_human' }) } })])).leadTimeHours).toBeUndefined()
  })

  it('快照已知时仅 loop 内 script 的结果计首跑率，父 loop/agent/loop 外结果不重复计数', async () => {
    const snapshot = workflow([
      node('outside'), node('loop', { kind: 'loop', body: [node('run'), node('agent', { kind: 'agent' }), node('inner', { kind: 'loop' })] }),
    ])
    const ids = ['outside', 'loop', 'loop/run', 'loop/agent', 'loop/inner', 'missing']
    const events = ids.flatMap((id, index) => [start(index * 2 + 1, id, 1), finish(index * 2 + 2, id, { failures: id === 'loop/run' ? [{ subject: 'TC-X' }] : [], total: 2 })])
    const metrics = await new FsInsights(stores({ runs: [run()], snapshots: { 'run-1': snapshot }, events: { 'run-1': events } })).metrics(requirement.id)
    expect(metrics.firstPassRate).toBe(0.5)
  })
})

describe('AC coverage and traceGraph', () => {
  const records = [
    artifact('spec/spec.md', 'spec', ['AC-1', 'AC-2', 'AC-3', 'AC-4']),
    artifact('cases/TC-ONE.json', 'case', ['TC-ONE', 'AC-1']),
    artifact('cases/TC-TWO.json', 'case', ['TC-TWO', 'AC-2']),
    artifact('cases/TC-THREE.json', 'case', ['TC-THREE', 'AC-2']),
    artifact('cases/TC-FOUR.json', 'case', ['TC-FOUR', 'AC-4']),
    artifact('evidence/TC-ONE/log.txt', 'evidence'), artifact('evidence/summary.json', 'evidence'),
  ]
  const contents = {
    'spec/spec.md': '# 验收\n- **AC-1**: 可以交付\n- AC-2：可以回滚\n- AC-3: 未覆盖\n- AC-4: 未执行\n',
    'cases/TC-ONE.json': JSON.stringify({ id: 'TC-ONE', title: '交付', covers: ['AC-1', 'AC-1'] }),
    'cases/TC-TWO.json': JSON.stringify({ id: 'TC-TWO', covers: ['AC-2'] }),
    'cases/TC-THREE.json': JSON.stringify({ id: 'TC-THREE', covers: ['AC-2'] }),
    'cases/TC-FOUR.json': JSON.stringify({ id: 'TC-FOUR', covers: ['AC-4'] }),
    'evidence/summary.json': JSON.stringify({ cases: [{ id: 'TC-ONE', status: 'passed' }, { id: 'TC-TWO', status: 'failed' }, { id: 'TC-THREE', status: 'error' }, { id: 'TC-UNKNOWN', status: 'passed' }] }),
  }

  it('严格使用模板的 cases/covers 和 summary/cases/status；没有结果保持 partial', async () => {
    const project = stores({ artifacts: records, contents })
    const metrics = await new FsInsights(project).metrics(requirement.id)
    expect(metrics.acCoverage).toEqual([
      { ac: 'AC-1', title: '可以交付', cases: 1, passed: 1, failed: 0, status: 'covered' },
      { ac: 'AC-2', title: '可以回滚', cases: 2, passed: 0, failed: 2, status: 'partial' },
      { ac: 'AC-3', title: '未覆盖', cases: 0, passed: 0, failed: 0, status: 'uncovered' },
      { ac: 'AC-4', title: '未执行', cases: 1, passed: 0, failed: 0, status: 'partial' },
    ])
  })

  it('缺少 summary 或仅有 succeeded/未知状态不当作 passed，非 spec AC 不增大分母', async () => {
    const custom = { ...contents, 'evidence/summary.json': JSON.stringify({ cases: [{ id: 'TC-ONE', status: 'succeeded' }] }), 'cases/TC-TWO.json': JSON.stringify({ id: 'TC-TWO', covers: ['AC-999'] }) }
    const metrics = await new FsInsights(stores({ artifacts: records, contents: custom })).metrics(requirement.id)
    expect(metrics.acCoverage?.find((entry) => entry.ac === 'AC-1')).toMatchObject({ passed: 0, failed: 0, status: 'partial' })
    expect(metrics.acCoverage?.some((entry) => entry.ac === 'AC-999')).toBe(false)
    const { 'evidence/summary.json': _summary, ...noSummary } = contents
    expect((await new FsInsights(stores({ artifacts: records, contents: noSummary })).metrics(requirement.id)).acCoverage?.every((entry) => entry.passed === 0)).toBe(true)
  })

  it('所有产物版本保留 derivedFrom/producedBy，外部引用有端点，证据连接用例', async () => {
    const changed = structuredClone(records)
    const testCase = changed[1]!
    testCase.versions[0]!.derivedFrom = [{ workspace: requirement.id, path: 'spec/spec.md', version: 1 }]
    testCase.versions[0]!.producedBy = { runId: 'run-1', nodeId: 'loop/run' }
    testCase.versions.push({ ...testCase.versions[0]!, version: 2, sha256: 'new', derivedFrom: [{ workspace: 'REQ-OTHER', path: 'external.md', version: 3 }, { workspace: requirement.id, path: 'spec/spec.md' }], producedBy: { runId: 'run-2', nodeId: 'loop/run' } })
    const graph = await new FsInsights(stores({ artifacts: changed, contents })).traceGraph(requirement.id)
    const versions = graph.nodes.filter((entry) => entry.ref?.path === testCase.path)
    expect(versions.map((entry) => entry.ref?.version).sort()).toEqual([1, 2])
    const v1 = versions.find((entry) => entry.ref?.version === 1)!
    const v2 = versions.find((entry) => entry.ref?.version === 2)!
    expect(graph.edges.filter((edge) => edge.rel === 'produced')).toEqual(expect.arrayContaining([
      { from: 'run-node:run-1:loop%2Frun', to: v1.id, rel: 'produced' },
      { from: 'run-node:run-2:loop%2Frun', to: v2.id, rel: 'produced' },
    ]))
    expect(graph.edges).toContainEqual({ from: 'TC-ONE', to: 'AC-1', rel: 'covers' })
    expect(graph.nodes.find((entry) => entry.id === 'TC-ONE')).toMatchObject({ status: 'passed', label: '交付' })
    expect(graph.edges.some((edge) => edge.to === 'TC-ONE' && edge.rel === 'verifies')).toBe(true)
    expect(graph.nodes.some((entry) => entry.ref?.workspace === 'REQ-OTHER' && entry.ref.version === 3)).toBe(true)
    const ids = new Set(graph.nodes.map((entry) => entry.id))
    expect(ids.size).toBe(graph.nodes.length)
    expect(graph.edges.every((edge) => ids.has(edge.from) && ids.has(edge.to))).toBe(true)
    expect(new Set(graph.edges.map((edge) => JSON.stringify(edge))).size).toBe(graph.edges.length)
  })

  it('非连续版本取版本号最大值，traceIds 不伪装成历史版本内容', async () => {
    const spec = artifact('spec/spec.md', 'spec', ['AC-1'])
    spec.versions.unshift({ ...spec.versions[0]!, version: 3 })
    const graph = await new FsInsights(stores({ artifacts: [spec], contents: { 'spec/spec.md': 'AC-1: 标准' } })).traceGraph(requirement.id)
    const derived = graph.edges.filter((edge) => edge.to === 'AC-1' && edge.from !== requirement.id)
    expect(derived).toHaveLength(1)
    expect(graph.nodes.find((entry) => entry.id === derived[0]?.from)?.ref?.version).toBe(3)
  })

  it.each(['spec/spec.md', 'cases/TC-ONE.json'])('清单中登记的 %s 丢失时不静默缩小覆盖率分母', async (path) => {
    const missing: Record<string, string> = { ...contents }
    delete missing[path]
    await expect(new FsInsights(stores({ artifacts: records, contents: missing })).metrics(requirement.id)).rejects.toThrow('产物内容缺失')
  })

  it.each([
    ['cases/TC-ONE.json', '{', '无法解析产物'],
    ['cases/TC-ONE.json', '{"id":"TC-ONE","covers":1}', '用例产物'],
    ['cases/TC-ONE.json', '{"id":"TC-TWO","covers":[]}', '用例 ID 重复'],
    ['evidence/summary.json', '{}', '必须包含 cases 数组'],
    ['evidence/summary.json', '{"cases":[{"id":"TC-ONE"}]}', '必须包含 id/status'],
    ['evidence/summary.json', '{"cases":[{"id":"TC-ONE","status":"passed"},{"id":"TC-ONE","status":"failed"}]}', '用例结果重复'],
  ])('错误数据 %s 给出上下文错误而非默认为通过', async (path, content, message) => {
    const insights = new FsInsights(stores({ artifacts: records, contents: { ...contents, [path]: content } }))
    await expect(insights.metrics(requirement.id)).rejects.toThrow(message)
  })
})

it('人工介入只计实际 human 回答，不重复计判决路由、自动批准或取消', async () => {
  const human = { type: 'human', id: 'reviewer' } as const
  const events = [
    { ...event(1, 'human.answered', { requestId: 'one', decision: 'approve' }), actor: human },
    { ...event(2, 'human.answered', { requestId: 'two', decision: 'approve' }), actor: { type: 'human', id: 'auto-approve' } as const },
    { ...event(3, 'human.answered', { requestId: 'three', decision: 'cancelled' }), actor: human },
    event(4, 'human.answered', { requestId: 'four', decision: 'approve' }),
    event(5, 'judge.verdict', { verdicts: [], routed: [{ subject: 'TC-1', to: 'human' }] }),
  ]
  expect((await createInsights(stores({ runs: [run()], events: { 'run-1': events } })).metrics('REQ-001')).humanInterventions).toBe(1)
})

it('持久化动态定义覆盖占位节点并提供实际依赖与元数据', () => {
  const snapshot = workflow([node('plan', { kind: 'planner', stage: 'test' })])
  const state = run({ expansions: [{ plannerId: 'plan', items: [], nodeIds: ['plan/a/dev', 'plan/b/review'], at: startedAt }] })
  const graph = buildRunGraph(snapshot, state, [
    { id: 'plan/a/dev', needs: [], parent: 'plan', kind: 'agent', title: '实现', role: 'dev', harness: 'codex' },
    { id: 'plan/b/review', needs: ['plan/a/dev'], parent: 'plan', kind: 'gate', title: '评审' },
  ])
  expect(graph.nodes.find((entry) => entry.id === 'plan/a/dev')).toMatchObject({ kind: 'agent', title: '实现', role: 'dev', harness: 'codex', stage: 'test' })
  expect(graph.edges).toContainEqual({ from: 'plan/a/dev', to: 'plan/b/review', kind: 'dep' })
})

it('Expansion.nodes 优先于旧 records，展开节点全限定 ID 与相对 loop body 不重复加前缀', () => {
  const snapshot = workflow([node('plan', { kind: 'planner', stage: 'test' })])
  const state = run({ expansions: [
    { plannerId: 'plan/a/loop/nested', items: [], at: startedAt, nodeIds: ['plan/a/loop/nested/b/dev'], nodes: [
      node('plan/a/loop/nested/b/dev', { kind: 'agent', title: '嵌套实现', role: 'dev', harness: 'mock', needs: ['plan/a/source'] }),
    ] },
    { plannerId: 'plan', items: [], at: startedAt, nodeIds: ['plan/a/source', 'plan/a/loop'], nodes: [
      node('plan/a/source', { kind: 'agent', title: '新定义', role: 'pm', harness: 'codex' }),
      node('plan/a/loop', { kind: 'loop', needs: ['plan/a/source'], body: [
        node('test'), node('judge', { kind: 'judge', needs: ['test'], routes: { product_bug: 'fix' } }),
        node('fix', { kind: 'agent', needs: ['judge'], role: 'dev' }), node('nested', { kind: 'planner', needs: ['fix'] }),
      ] }),
    ] },
  ] })
  const graph = buildRunGraph(snapshot, state, [
    { id: 'plan/a/source', kind: 'script', title: '旧定义', role: 'old', parent: 'wrong', stage: 'wrong', harness: 'old', needs: ['plan/a/loop'] },
    { id: 'plan/a/loop/fix', kind: 'human', title: '旧子节点', needs: ['plan/a/source'] },
  ])
  expect(graph.nodes).toHaveLength(8)
  expect(graph.nodes.find((entry) => entry.id === 'plan/a/source')).toMatchObject({ kind: 'agent', title: '新定义', role: 'pm', harness: 'codex', parent: 'plan', stage: 'test' })
  expect(graph.nodes.find((entry) => entry.id === 'plan/a/loop/fix')).toMatchObject({ kind: 'agent', role: 'dev', parent: 'plan/a/loop', stage: 'test' })
  expect(graph.nodes.find((entry) => entry.id === 'plan/a/loop/nested/b/dev')).toMatchObject({ kind: 'agent', title: '嵌套实现', parent: 'plan/a/loop/nested', stage: 'test' })
  expect(graph.edges).toEqual(expect.arrayContaining([
    { from: 'plan/a/source', to: 'plan/a/loop', kind: 'dep' },
    { from: 'plan/a/loop/test', to: 'plan/a/loop/judge', kind: 'dep' },
    { from: 'plan/a/loop/judge', to: 'plan/a/loop/fix', kind: 'route', label: 'product_bug' },
    { from: 'plan/a/loop/judge', to: 'plan/a/loop/fix', kind: 'dep' },
    { from: 'plan/a/source', to: 'plan/a/loop/nested/b/dev', kind: 'dep' },
  ]))
  expect(graph.edges).not.toContainEqual({ from: 'plan/a/loop', to: 'plan/a/source', kind: 'dep' })
  expect(graph.edges).not.toContainEqual({ from: 'plan/a/source', to: 'plan/a/loop/fix', kind: 'dep' })
})

it('旧运行（没有 harness.usage）按所有完成事件累计 loop/retry，已删除节点仍计入运行总量，空日志不使用 state', () => {
  const snapshot = workflow([node('loop', { kind: 'loop', body: [node('dev')] })])
  const state = run({ nodes: { 'loop/dev': runtime('loop/dev', { usage: { inputTokens: 999, outputTokens: 999 } }) } })
  const events = [
    event(1, 'node.finished', { status: 'failed', outputs: [], usage: { inputTokens: 10, outputTokens: 2, cachedTokens: 1, costUsd: 0.1 } }, 'loop/dev'),
    event(3, 'node.finished', { status: 'succeeded', outputs: [], usage: { inputTokens: 20, outputTokens: 3, cachedTokens: 2, costUsd: 0.2 } }, 'loop/dev'),
    event(4, 'node.finished', { status: 'succeeded', outputs: [], usage: { inputTokens: 7, outputTokens: 1 } }, 'loop/removed'),
    event(1, 'node.finished', { status: 'succeeded', outputs: [], usage: { inputTokens: 888, outputTokens: 888 } }, 'loop/dev', 'other'),
  ]
  const before = JSON.stringify(state)
  expect(summarizeRun(state, events).usage).toEqual({ inputTokens: 37, outputTokens: 6, cachedTokens: 3, costUsd: expect.closeTo(0.3) })
  expect(buildRunGraph(snapshot, state, [], events).nodes.find((item) => item.id === 'loop/dev')?.usage).toEqual({ inputTokens: 30, outputTokens: 5, cachedTokens: 3, costUsd: expect.closeTo(0.3) })
  expect(buildRunGraph(snapshot, state, [], events).nodes.some((item) => item.id === 'loop/removed')).toBe(false)
  expect(summarizeRun(state, []).usage).toEqual({ inputTokens: 0, outputTokens: 0 })
  expect(buildRunGraph(snapshot, state, [], []).nodes.find((item) => item.id === 'loop/dev')?.usage).toEqual({ inputTokens: 0, outputTokens: 0 })
  expect(buildRunGraph(snapshot, state).nodes.find((item) => item.id === 'loop/dev')?.usage).toEqual(state.nodes['loop/dev']!.usage)
  expect(JSON.stringify(state)).toBe(before)
})

it('有 harness.usage 时节点用量是每次调用之和：评审多位评审、多轮都算，不只最后一次', () => {
  const snapshot = workflow([node('review')])
  const state = run({ nodes: { review: runtime('review') } })
  const events = [
    event(1, 'harness.usage', { inputTokens: 100, outputTokens: 10 }, 'review'),
    event(2, 'harness.usage', { inputTokens: 200, outputTokens: 20 }, 'review'),
    event(3, 'node.finished', { status: 'succeeded', outputs: [], usage: { inputTokens: 200, outputTokens: 20 } }, 'review'),
    event(4, 'harness.usage', { inputTokens: 5, outputTokens: 1 }),
  ]
  expect(buildRunGraph(snapshot, state, [], events).nodes.find((item) => item.id === 'review')?.usage).toEqual({ inputTokens: 300, outputTokens: 30 })
  expect(summarizeRun(state, events).usage).toEqual({ inputTokens: 305, outputTokens: 31 })
})
