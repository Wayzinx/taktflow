import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import {
  createEngine, initProject, snapshotWorkflow, withdrawArtifact,
  type Actor, type ApiError, type ArtifactComment, type ArtifactContent, type ArtifactEditResponse,
  type ArtifactRecord, type AttentionItem, type EventEnvelope, type HarnessAdapter, type HarnessInfo,
  type HarnessRequest, type ModelInfo, type NodeContext,
  type NodeDetail, type ProjectOverview, type ProjectStores, type RequirementDetail,
  type RequirementMetrics, type RequirementSummary, type RunDetail, type RunState, type RunSummary,
  type TraceGraph, type WorkflowDefinition,
} from '@taktflow/core'
import { createServer, type ServerOptions } from './index.js'

type Cleanup = () => Promise<void>
const cleanups: Cleanup[] = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    try {
      await cleanup()
    } catch {
      // 清理失败不掩盖测试结果
    }
  }
})

async function startServer(options: {
  projectDir: string
  webDir?: string
  onAnswer?: (item: AttentionItem) => void
  getHarnesses?: ServerOptions['getHarnesses']
  getModels?: ServerOptions['getModels']
}): Promise<{ url: string; close: () => Promise<void> }> {
  const server = await createServer({ ...options, port: 0, host: '127.0.0.1' })
  cleanups.push(() => server.close())
  return server
}

async function getJson<T>(url: string, headers?: Record<string, string>): Promise<{ status: number; body: T }> {
  const res = await fetch(url, { headers })
  const body = (await res.json()) as T
  return { status: res.status, body }
}

it('撤回产物不在当前列表中，HTTP 指定历史版本仍能读取', async () => {
  const f = await makeFixture()
  const { url } = await startServer({ projectDir: f.root })
  const ref = { workspace: f.requirementId, path: 'spec/spec.md' }
  await withdrawArtifact(f.stores, { ref, author: { type: 'human', id: 'tester' }, reason: '旧规格无效' })
  const endpoint = `${url}/api/requirements/${f.requirementId}`
  expect((await getJson<ArtifactRecord[]>(`${endpoint}/artifacts`)).body.some(a => a.path === ref.path)).toBe(false)
  expect((await getJson(`${endpoint}/artifact?path=${ref.path}`)).status).toBe(404)
  const old = await getJson<ArtifactContent>(`${endpoint}/artifact?path=${ref.path}&version=1`)
  expect(old.status).toBe(200)
  expect(old.body.content).toContain('AC-1')
  expect((await getJson(`${endpoint}/artifact?path=${ref.path}&version=2`)).status).toBe(404)
})

interface Fixture {
  root: string
  stores: ProjectStores
  requirementId: string
  runId: string
}

/** 临时项目：1 个需求、3 个产物、1 次运行（含 loop 子节点）、9 条事件、1 条待办。 */
async function makeFixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'takt-server-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const stores = await initProject(root, { name: '服务端集成' })
  const requirement = await stores.workspaces.createRequirement({ title: '服务端集成测试' })
  const actor: Actor = { type: 'system', id: 'fixture' }
  const spec = await stores.workspaces.writeArtifact({
    ref: { workspace: requirement.id, path: 'spec/spec.md' },
    content: '# 规格\n- AC-1: 可以创建\n', kind: 'spec', author: actor,
  })
  const cases = await stores.workspaces.writeArtifact({
    ref: { workspace: requirement.id, path: 'cases/TC-ONE.json' },
    content: JSON.stringify({ id: 'TC-ONE', covers: ['AC-1'] }),
    kind: 'case', author: actor, derivedFrom: [spec],
  })
  await stores.workspaces.writeArtifact({
    ref: { workspace: requirement.id, path: 'evidence/summary.json' },
    content: JSON.stringify({ cases: [{ id: 'TC-ONE', status: 'passed' }] }),
    kind: 'evidence', author: actor,
  })

  const workflow: WorkflowDefinition = {
    id: 'delivery', title: '交付', version: '1',
    stages: [{ id: 'dev', title: '研发' }, { id: 'test', title: '测试' }],
    nodes: [
      {
        id: 'spec-agent', kind: 'agent', title: '写规格', stage: 'dev', role: 'pm', prompt: '写规格',
        inputs: [{ path: 'spec/spec.md' }], outputs: [{ path: 'cases/TC-ONE.json', kind: 'case' }],
      },
      { id: 'verify', kind: 'script', title: '校验', stage: 'test', needs: ['spec-agent'], run: async () => undefined },
      {
        id: 'loop', kind: 'loop', title: '研发测试循环', stage: 'test', maxIterations: 2,
        until: () => true,
        body: [{ id: 'run', kind: 'script', title: '执行用例', run: async () => undefined }],
      },
    ],
  }
  const runId = 'run-server-1'
  const usage = { inputTokens: 100, outputTokens: 20 }
  const state: RunState = {
    runId, requirementId: requirement.id, workflowId: workflow.id, workflowVersion: workflow.version,
    status: 'succeeded', startedAt: '2026-11-04T00:00:00.000Z', endedAt: '2026-11-04T00:05:00.000Z',
    args: {}, expansions: [],
    nodes: {
      'spec-agent': {
        id: 'spec-agent', status: 'succeeded', attempts: 1, usage,
        inputs: [{ workspace: requirement.id, path: 'spec/spec.md', version: 1 }],
        outputs: [{ workspace: requirement.id, path: 'cases/TC-ONE.json', version: cases.version }],
      },
      verify: {
        id: 'verify', status: 'succeeded', attempts: 1,
        inputs: [{ workspace: requirement.id, path: 'cases/TC-ONE.json', version: cases.version }], outputs: [],
      },
      loop: { id: 'loop', status: 'succeeded', attempts: 1, outputs: [] },
      'loop/run': {
        id: 'loop/run', status: 'succeeded', attempts: 1, iteration: 1,
        outputs: [{ workspace: requirement.id, path: 'evidence/summary.json', version: 1 }],
      },
    },
  }
  await stores.runs.create(state, snapshotWorkflow(workflow))

  const context = {
    nodeId: 'spec-agent', at: '2026-11-04T00:00:01.000Z', budgetTokens: 8000, totalTokens: 120,
    items: [{ id: 'spec', source: 'artifact' as const, title: '规格', ref: 'spec/spec.md', tokens: 120, included: true }],
  }
  const events = [
    { type: 'run.started' as const, data: { workflowId: workflow.id, workflowVersion: workflow.version, args: {} } },
    { type: 'node.started' as const, nodeId: 'spec-agent', data: { attempt: 1 } },
    { type: 'context.assembled' as const, nodeId: 'spec-agent', data: context },
    { type: 'harness.usage' as const, nodeId: 'spec-agent', data: usage },
    { type: 'node.finished' as const, nodeId: 'spec-agent', data: { status: 'succeeded' as const, outputs: [], usage } },
    {
      type: 'gate.result' as const, nodeId: 'verify',
      data: { pass: true, checks: [{ id: 'c1', pass: true, message: '通过' }] },
    },
    {
      type: 'judge.verdict' as const, nodeId: 'verify',
      data: {
        verdicts: [{
          subject: 'TC-ONE', category: 'product_bug' as const, confidence: 0.9,
          rationale: '断言失败', evidence: ['evidence/summary.json'],
        }],
        routed: [{ subject: 'TC-ONE', to: 'spec-agent' }],
      },
    },
    { type: 'node.started' as const, nodeId: 'loop/run', data: { attempt: 1, iteration: 1 } },
    { type: 'node.finished' as const, nodeId: 'loop/run', data: { status: 'succeeded' as const, outputs: [] } },
    { type: 'run.finished' as const, data: { status: 'succeeded' as const } },
  ]
  for (const event of events) {
    await stores.events.append(runId, { ...event, actor })
  }
  await stores.attention.create({
    requestId: 'att-1', runId, nodeId: 'spec-agent', requirementId: requirement.id,
    ask: '是否继续？', form: 'approve',
  })
  return { root, stores, requirementId: requirement.id, runId }
}

it('GET /api/project、/api/requirements 与需求详情', async () => {
  const fixture = await makeFixture()
  const server = await startServer({ projectDir: fixture.root })

  const overview = await getJson<ProjectOverview>(`${server.url}/api/project`)
  expect(overview.status).toBe(200)
  expect(overview.body.name).toBe('服务端集成')
  expect(overview.body.requirements.map((r) => r.id)).toEqual([fixture.requirementId])
  expect(overview.body.totals).toMatchObject({ requirements: 1, runs: 1 })
  expect(overview.body.attention.map((a) => a.requestId)).toContain('att-1')

  const summary = overview.body.requirements[0]!
  expect(summary.status).toBe('delivered')
  expect(overview.body.totals.delivered).toBe(1)
  expect(summary.latestRunId).toBe(fixture.runId)
  expect(summary.pendingAttention).toBe(1)
  expect(summary.stages.map((s) => s.id)).toEqual(['dev', 'test'])
  expect(summary.stages[0]).toMatchObject({ status: 'done', done: 1, total: 1 })
  expect(summary.stages[1]).toMatchObject({ status: 'done', done: 3, total: 3 })
  expect(summary.usage.inputTokens).toBe(100)

  const list = await getJson<RequirementSummary[]>(`${server.url}/api/requirements`)
  expect(list.status).toBe(200)
  expect(list.body).toHaveLength(1)

  const detail = await getJson<RequirementDetail>(`${server.url}/api/requirements/${fixture.requirementId}`)
  expect(detail.status).toBe(200)
  expect(detail.body.artifacts.map((a) => a.path).sort()).toEqual(
    ['cases/TC-ONE.json', 'evidence/summary.json', 'spec/spec.md'],
  )
  expect(detail.body.runs.map((r) => r.runId)).toEqual([fixture.runId])
  expect(detail.body.stages).toHaveLength(2)

  const missing = await getJson<ApiError>(`${server.url}/api/requirements/REQ-999`)
  expect(missing.status).toBe(404)
  expect(typeof missing.body.error).toBe('string')
})

it('GET 产物列表 / 内容与评论读写', async () => {
  const fixture = await makeFixture()
  const server = await startServer({ projectDir: fixture.root })
  const base = `${server.url}/api/requirements/${fixture.requirementId}`

  const artifacts = await getJson<ArtifactRecord[]>(`${base}/artifacts`)
  expect(artifacts.status).toBe(200)
  const specRecord = artifacts.body.find((a) => a.path === 'spec/spec.md')!
  expect(specRecord.kind).toBe('spec')
  expect(specRecord.versions).toHaveLength(1)
  expect(specRecord.versions[0]!.author).toEqual({ type: 'system', id: 'fixture' })

  const content = await getJson<ArtifactContent>(`${base}/artifact?path=${encodeURIComponent('spec/spec.md')}&version=1`)
  expect(content.status).toBe(200)
  expect(content.body).toMatchObject({ path: 'spec/spec.md', version: 1, encoding: 'utf8' })
  expect(content.body.content).toContain('AC-1')

  const latest = await getJson<ArtifactContent>(`${base}/artifact?path=${encodeURIComponent('spec/spec.md')}`)
  expect(latest.body.version).toBe(1)

  const comments = await getJson<ArtifactComment[]>(`${base}/comments?path=${encodeURIComponent('spec/spec.md')}`)
  expect(comments.body).toEqual([])

  const created = await fetch(`${base}/comments`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-takt-user': 'bob' },
    body: JSON.stringify({ path: 'spec/spec.md', version: 1, body: '这里补一条 AC' }),
  })
  expect(created.status).toBe(200)
  const comment = (await created.json()) as ArtifactComment
  expect(comment).toMatchObject({
    path: 'spec/spec.md', version: 1, body: '这里补一条 AC', author: { type: 'human', id: 'bob' },
  })
  expect(comment.id).toBeTruthy()
  expect(comment.createdAt).toBeTruthy()

  const after = await getJson<ArtifactComment[]>(`${base}/comments`)
  expect(after.body.map((c) => c.id)).toEqual([comment.id])

  const invalid = await fetch(`${base}/comments`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: 'spec/spec.md' }),
  })
  expect(invalid.status).toBe(400)
})

it('GET 运行列表 / 详情 / 事件 / 节点详情 / 审计', async () => {
  const fixture = await makeFixture()
  const server = await startServer({ projectDir: fixture.root })

  const runs = await getJson<RunSummary[]>(`${server.url}/api/runs?requirement=${fixture.requirementId}`)
  expect(runs.status).toBe(200)
  expect(runs.body.map((r) => r.runId)).toEqual([fixture.runId])
  expect(runs.body[0]!.progress).toMatchObject({ done: 4, total: 4, failed: 0 })
  expect(runs.body[0]!.usage.inputTokens).toBe(100)

  const detail = await getJson<RunDetail>(`${server.url}/api/runs/${fixture.runId}`)
  expect(detail.status).toBe(200)
  expect(detail.body.run.status).toBe('succeeded')
  expect(detail.body.workflow).toMatchObject({ id: 'delivery', version: '1' })
  expect(detail.body.graph.nodes.map((n) => n.id).sort()).toEqual(['loop', 'loop/run', 'spec-agent', 'verify'])
  expect(detail.body.graph.nodes.find((n) => n.id === 'loop/run')!.parent).toBe('loop')
  expect(detail.body.graph.edges).toEqual(expect.arrayContaining([
    expect.objectContaining({ from: 'spec-agent', to: 'verify', kind: 'dep' }),
  ]))

  const events = await getJson<EventEnvelope[]>(`${server.url}/api/runs/${fixture.runId}/events`)
  expect(events.status).toBe(200)
  expect(events.body.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
  expect(events.body.at(-1)!.type).toBe('run.finished')

  const after = await getJson<EventEnvelope[]>(`${server.url}/api/runs/${fixture.runId}/events?after=8`)
  expect(after.body.map((e) => e.seq)).toEqual([9, 10])

  const byNode = await getJson<EventEnvelope[]>(
    `${server.url}/api/runs/${fixture.runId}/events?node=${encodeURIComponent('spec-agent')}`,
  )
  expect(byNode.body).toHaveLength(4)
  expect(byNode.body.every((e) => e.nodeId === 'spec-agent')).toBe(true)

  const agent = await getJson<NodeDetail>(`${server.url}/api/runs/${fixture.runId}/nodes/spec-agent`)
  expect(agent.status).toBe(200)
  expect(agent.body).toMatchObject({ kind: 'agent', title: '写规格', prompt: '写规格' })
  expect(agent.body.inputs[0]).toMatchObject({ path: 'spec/spec.md' })
  expect(agent.body.outputs[0]).toMatchObject({ path: 'cases/TC-ONE.json' })
  expect(agent.body.context.snapshots).toHaveLength(1)
  expect(agent.body.events).toHaveLength(4)

  const loopBody = await getJson<NodeDetail>(`${server.url}/api/runs/${fixture.runId}/nodes/${encodeURIComponent('loop/run')}`)
  expect(loopBody.status).toBe(200)
  expect(loopBody.body.state.id).toBe('loop/run')
  expect(loopBody.body.events.map((e) => e.type)).toEqual(['node.started', 'node.finished'])

  const judged = await getJson<NodeDetail>(`${server.url}/api/runs/${fixture.runId}/nodes/verify`)
  expect(judged.body.verdicts?.[0]).toMatchObject({ subject: 'TC-ONE', category: 'product_bug' })
  expect(judged.body.gate).toMatchObject({ pass: true })

  const audit = await getJson<{ ok: boolean }>(`${server.url}/api/runs/${fixture.runId}/audit`)
  expect(audit.body.ok).toBe(true)
  expect((await getJson<ApiError>(`${server.url}/api/runs/nope`)).status).toBe(404)
})

it('GET 追溯图与度量', async () => {
  const fixture = await makeFixture()
  const server = await startServer({ projectDir: fixture.root })
  const base = `${server.url}/api/requirements/${fixture.requirementId}`

  const trace = await getJson<TraceGraph>(`${base}/trace`)
  expect(trace.status).toBe(200)
  expect(trace.body.nodes.map((n) => n.type)).toEqual(expect.arrayContaining(['requirement', 'ac', 'artifact']))
  expect(trace.body.edges.map((e) => e.rel)).toEqual(expect.arrayContaining(['covers', 'derives']))

  const metrics = await getJson<RequirementMetrics>(`${base}/metrics`)
  expect(metrics.status).toBe(200)
  expect(metrics.body.requirementId).toBe(fixture.requirementId)
  expect(metrics.body.runs).toBe(1)
  expect(metrics.body.usage.inputTokens).toBe(100)
  expect(metrics.body.acCoverage?.map((c) => c.ac)).toContain('AC-1')
})

it('GET /api/harnesses 与 /api/models 透传注入的能力矩阵与模型别名', async () => {
  const fixture = await makeFixture()
  const harnessRows: HarnessInfo[] = [{ id: 'test', displayName: 'Test', source: 'plugin', available: true, capabilities: { usage: true }, roles: ['dev'] }]
  const modelRows: ModelInfo[] = [{ alias: 'fast', provider: 'demo', protocol: 'openai-chat', id: 'demo-fast', contextWindow: 128000, keyPresent: false }]
  const server = await startServer({ projectDir: fixture.root, getHarnesses: async () => harnessRows, getModels: async () => modelRows })
  expect(await getJson<HarnessInfo[]>(`${server.url}/api/harnesses`)).toEqual({ status: 200, body: harnessRows.map(row => ({ ...row, hidden: false, testOnly: false })) })
  expect(await getJson<ModelInfo[]>(`${server.url}/api/models`)).toEqual({ status: 200, body: modelRows })
})

it('节点 HTTP 详情从持久化快照返回 rubric checks.threshold', async () => {
  const fixture = await makeFixture()
  const state = (await fixture.stores.runs.get(fixture.runId))!
  const snapshot = (await fixture.stores.runs.getWorkflow(fixture.runId))!
  const checks = [{ id: 'quality', kind: 'rubric' as const, title: '质量', threshold: 87 }]
  const gate = snapshot.nodes.find((node) => node.id === 'verify')!
  gate.kind = 'gate'
  gate.checks = checks
  await fixture.stores.runs.create({ ...state, runId: 'run-threshold' }, snapshot)
  const server = await startServer({ projectDir: fixture.root })
  const response = await getJson<NodeDetail>(`${server.url}/api/runs/run-threshold/nodes/verify`)
  expect(response.status).toBe(200)
  expect(response.body.kind).toBe('gate')
  expect(response.body.checks).toEqual(checks)
})

it('未知 /api 路由 404，跨域响应带 CORS 头', async () => {
  const fixture = await makeFixture()
  const server = await startServer({ projectDir: fixture.root })

  const notFound = await getJson<ApiError>(`${server.url}/api/unknown`)
  expect(notFound.status).toBe(404)
  expect(notFound.body.error).toBeTruthy()

  const cors = await fetch(`${server.url}/api/project`, { headers: { origin: 'http://localhost:5173' } })
  expect(cors.headers.get('access-control-allow-origin')).toBe('http://localhost:5173')
})

it('无 webDir 时根路径 404，webDir 存在时托管静态文件并回退 SPA', async () => {
  const fixture = await makeFixture()
  const bare = await startServer({ projectDir: fixture.root })
  expect((await fetch(`${bare.url}/`)).status).toBe(404)

  const webDir = join(fixture.root, 'web')
  await mkdir(join(webDir, 'assets'), { recursive: true })
  await writeFile(join(webDir, 'index.html'), '<!doctype html><title>takt web</title>')
  await writeFile(join(webDir, 'assets/app.js'), 'console.log("app")')
  const server = await startServer({ projectDir: fixture.root, webDir })

  const index = await fetch(`${server.url}/`)
  expect(index.status).toBe(200)
  expect(index.headers.get('content-type')).toContain('text/html')
  expect(await index.text()).toContain('takt web')

  const asset = await fetch(`${server.url}/assets/app.js`)
  expect(asset.status).toBe(200)
  expect(await asset.text()).toContain('console.log("app")')

  const spa = await fetch(`${server.url}/requirements/${fixture.requirementId}/detail`)
  expect(spa.status).toBe(200)
  expect(await spa.text()).toContain('takt web')

  const api = await getJson<ProjectOverview>(`${server.url}/api/project`)
  expect(api.status).toBe(200)
  expect(api.body.name).toBe('服务端集成')
})

it('PUT 产物写入新版本并传播 stale，缺 reason / path 返回 400', async () => {
  const fixture = await makeFixture()
  const server = await startServer({ projectDir: fixture.root })
  const url = `${server.url}/api/requirements/${fixture.requirementId}/artifact?path=${encodeURIComponent('spec/spec.md')}`

  const edited = await fetch(url, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', 'x-takt-user': 'alice' },
    body: JSON.stringify({ content: '# 规格 v2\n- AC-1: 可以创建\n- AC-2: 可以撤销\n', reason: '补充验收标准' }),
  })
  expect(edited.status).toBe(200)
  const edit = (await edited.json()) as ArtifactEditResponse
  expect(edit.version).toBe(2)
  expect(edit.staleNodes).toEqual(expect.arrayContaining([
    { runId: fixture.runId, nodeId: 'spec-agent' },
    { runId: fixture.runId, nodeId: 'verify' },
  ]))

  const records = await fixture.stores.workspaces.listArtifacts(fixture.requirementId)
  const spec = records.find((r) => r.path === 'spec/spec.md')!
  expect(spec.versions).toHaveLength(2)
  expect(spec.versions[1]!).toMatchObject({
    version: 2, reason: '补充验收标准', author: { type: 'human', id: 'alice' },
  })

  const state = await fixture.stores.runs.get(fixture.runId)
  expect(state!.nodes['spec-agent']!.status).toBe('stale')
  expect(state!.nodes.verify!.status).toBe('stale')
  expect(state!.nodes.loop!.status).toBe('succeeded')

  const staleEvents = await fixture.stores.events.read(fixture.runId, { types: ['node.stale'] })
  expect(staleEvents.map((e) => e.nodeId).sort()).toEqual(['spec-agent', 'verify'])

  const content = await getJson<ArtifactContent>(
    `${server.url}/api/requirements/${fixture.requirementId}/artifact?path=${encodeURIComponent('spec/spec.md')}`,
  )
  expect(content.body.version).toBe(2)
  expect(content.body.content).toContain('AC-2')

  const noReason = await fetch(url, {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content: 'x' }),
  })
  expect(noReason.status).toBe(400)
  expect(((await noReason.json()) as ApiError).error).toBeTruthy()

  const noPath = await fetch(`${server.url}/api/requirements/${fixture.requirementId}/artifact`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ content: 'x', reason: 'y' }),
  })
  expect(noPath.status).toBe(400)
})

it('GET /api/attention?pending=1 与 POST 回答触发 onAnswer', async () => {
  const fixture = await makeFixture()
  const answered: AttentionItem[] = []
  const server = await startServer({ projectDir: fixture.root, onAnswer: (item) => answered.push(item) })

  const pending = await getJson<AttentionItem[]>(`${server.url}/api/attention?pending=1`)
  expect(pending.status).toBe(200)
  expect(pending.body.map((a) => a.requestId)).toEqual(['att-1'])
  expect(pending.body[0]!.ask).toBe('是否继续？')

  const res = await fetch(`${server.url}/api/attention/att-1`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-takt-user': 'alice' },
    body: JSON.stringify({ decision: 'approve' }),
  })
  expect(res.status).toBe(200)
  const item = (await res.json()) as AttentionItem
  expect(item).toMatchObject({ requestId: 'att-1', decision: 'approve' })
  expect(item.answeredAt).toBeTruthy()

  await new Promise((resolve) => setTimeout(resolve, 50))
  expect(answered).toHaveLength(1)
  expect(answered[0]!.requestId).toBe('att-1')

  const after = await getJson<AttentionItem[]>(`${server.url}/api/attention?pending=1`)
  expect(after.body).toEqual([])

  const unknown = await fetch(`${server.url}/api/attention/nope`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ answer: 'x' }),
  })
  expect(unknown.status).toBe(404)
})

/**
 * 同一份起始状态的两个副本，供 markStale 双入口一致性对比：
 * reader 读 spec → reader-after 依赖它；loop/inner 读 spec → loop 父 → loop-after；
 * other 只读 other.md，两个入口都应保持 succeeded。
 */
async function makeStaleParityProject(): Promise<Fixture & { workflow: WorkflowDefinition; state: RunState }> {
  const root = await mkdtemp(join(tmpdir(), 'takt-stale-parity-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const stores = await initProject(root, { name: '过期入口一致性' })
  const requirement = await stores.workspaces.createRequirement({ title: '过期入口一致性' })
  const actor: Actor = { type: 'system', id: 'fixture' }
  const spec = await stores.workspaces.writeArtifact({
    ref: { workspace: requirement.id, path: 'spec/spec.md' },
    content: '# 规格\n- AC-1: 初始\n', kind: 'spec', author: actor,
  })
  const other = await stores.workspaces.writeArtifact({
    ref: { workspace: requirement.id, path: 'inputs/other.md' },
    content: '无关输入\n', kind: 'input', author: actor,
  })

  const workflow: WorkflowDefinition = {
    id: 'stale-parity', title: '过期入口一致性', version: '1',
    stages: [{ id: 'work', title: '工作' }],
    nodes: [
      { id: 'reader', kind: 'script', title: '读规格', stage: 'work', inputs: [{ path: 'spec/spec.md' }], run: async () => undefined },
      { id: 'reader-after', kind: 'script', title: '阅读下游', stage: 'work', needs: ['reader'], run: async () => undefined },
      {
        id: 'loop', kind: 'loop', title: '循环', stage: 'work', maxIterations: 1, until: () => true,
        body: [{ id: 'inner', kind: 'script', title: '读规格子节点', inputs: [{ path: 'spec/spec.md' }], run: async () => undefined }],
      },
      { id: 'loop-after', kind: 'script', title: '循环下游', stage: 'work', needs: ['loop'], run: async () => undefined },
      { id: 'other', kind: 'script', title: '无关节点', stage: 'work', inputs: [{ path: 'inputs/other.md' }], run: async () => undefined },
    ],
  }
  const runId = 'run-stale-parity-1'
  const state: RunState = {
    runId, requirementId: requirement.id, workflowId: workflow.id, workflowVersion: workflow.version,
    status: 'succeeded', startedAt: '2026-11-04T00:00:00.000Z', endedAt: '2026-11-04T00:05:00.000Z',
    args: {}, expansions: [],
    nodes: {
      reader: {
        id: 'reader', status: 'succeeded', attempts: 1,
        inputs: [{ workspace: requirement.id, path: 'spec/spec.md', version: spec.version }], outputs: [],
      },
      'reader-after': { id: 'reader-after', status: 'succeeded', attempts: 1, outputs: [] },
      loop: { id: 'loop', status: 'succeeded', attempts: 1, outputs: [] },
      'loop/inner': {
        id: 'loop/inner', status: 'succeeded', attempts: 1, iteration: 1,
        inputs: [{ workspace: requirement.id, path: 'spec/spec.md', version: spec.version }], outputs: [],
      },
      'loop-after': { id: 'loop-after', status: 'succeeded', attempts: 1, outputs: [] },
      other: {
        id: 'other', status: 'succeeded', attempts: 1,
        inputs: [{ workspace: requirement.id, path: 'inputs/other.md', version: other.version }], outputs: [],
      },
    },
  }
  await stores.runs.create(state, snapshotWorkflow(workflow))
  return { root, stores, requirementId: requirement.id, runId, workflow, state }
}

const nodeStatuses = (state: RunState): Record<string, string> =>
  Object.fromEntries(Object.entries(state.nodes).map(([id, node]) => [id, node.status]))

it('engine.markStale 与 HTTP PUT 产物对同一起始状态的失效集合完全一致', async () => {
  const engineSide = await makeStaleParityProject()
  const httpSide = await makeStaleParityProject()
  // 两入口的起始状态必须逐字段相同（runId/requirementId 相同，内容也相同）。
  expect(engineSide.state).toEqual(httpSide.state)
  expect(engineSide.runId).toBe(httpSide.runId)
  const expected = ['loop', 'loop-after', 'loop/inner', 'reader', 'reader-after']

  const engine = createEngine({
    stores: engineSide.stores, harnesses: {}, profiles: {}, knowledge: [],
  })
  const engineStale = await engine.markStale(engineSide.runId, {
    workspace: engineSide.requirementId, path: 'spec/spec.md', version: 2,
  })

  const server = await startServer({ projectDir: httpSide.root })
  const res = await fetch(
    `${server.url}/api/requirements/${httpSide.requirementId}/artifact?path=${encodeURIComponent('spec/spec.md')}`,
    {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'x-takt-user': 'alice' },
      body: JSON.stringify({ content: '# 规格\n- AC-1: 修改后\n', reason: '修改规格' }),
    },
  )
  expect(res.status).toBe(200)
  const edit = (await res.json()) as ArtifactEditResponse
  expect(edit.version).toBe(2)
  const httpStale = edit.staleNodes.filter((item) => item.runId === httpSide.runId).map((item) => item.nodeId)

  // 明确预期集合，防止两个入口都返回空也“相等”。
  expect([...engineStale].sort()).toEqual(expected)
  expect([...httpStale].sort()).toEqual(expected)
  expect([...engineStale].sort()).toEqual([...httpStale].sort())

  const engineState = (await engineSide.stores.runs.get(engineSide.runId))!
  const httpState = (await httpSide.stores.runs.get(httpSide.runId))!
  const expectedStatuses = {
    loop: 'stale', 'loop-after': 'stale', 'loop/inner': 'stale',
    reader: 'stale', 'reader-after': 'stale', other: 'succeeded',
  }
  expect(nodeStatuses(engineState)).toEqual(expectedStatuses)
  expect(nodeStatuses(httpState)).toEqual(expectedStatuses)

  const staleEvents = async (stores: ProjectStores, runId: string) =>
    (await stores.events.read(runId, { types: ['node.stale'] })).map((event) => event.nodeId!).sort()
  expect(await staleEvents(engineSide.stores, engineSide.runId)).toEqual(expected)
  expect(await staleEvents(httpSide.stores, httpSide.runId)).toEqual(expected)
  for (const event of await httpSide.stores.events.read(httpSide.runId, { types: ['node.stale'] })) {
    expect((event.data as { cause: { path: string; version?: number } }).cause).toMatchObject({ path: 'spec/spec.md', version: 2 })
  }

  expect(await engineSide.stores.events.verify(engineSide.runId)).toEqual({ ok: true })
  expect(await httpSide.stores.events.verify(httpSide.runId)).toEqual({ ok: true })
})

/** 读一段 SSE 数据，超时即失败，避免测试挂死。 */
async function readChunk(reader: ReadableStreamDefaultReader<Uint8Array>, timeoutMs = 5000): Promise<string> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      reader.read().then(({ value, done }) => {
        if (done) throw new Error('SSE 连接提前关闭')
        return new TextDecoder().decode(value)
      }),
      new Promise<string>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`SSE 读取超时（${timeoutMs}ms）`)), timeoutMs)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

/** 取出每个 SSE 事件块里 data: 后面的 JSON 文本。 */
function sseData(text: string): string[] {
  return text.replace(/\r\n/g, '\n').split('\n\n')
    .filter((block) => block.split('\n').some((line) => line.startsWith('data:')))
    .map((block) => block.split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trim())
      .join('\n'))
}

it('SSE 先推历史事件、再推实时事件，断开后清理订阅', async () => {
  const fixture = await makeFixture()
  const server = await startServer({ projectDir: fixture.root })
  const controller = new AbortController()
  const res = await fetch(`${server.url}/api/runs/${fixture.runId}/stream?after=0`, {
    headers: { accept: 'text/event-stream' },
    signal: controller.signal,
  })
  expect(res.status).toBe(200)
  expect(res.headers.get('content-type')).toContain('text/event-stream')
  const reader = res.body!.getReader()

  let buffer = ''
  while (sseData(buffer).length < 10) buffer += await readChunk(reader)
  const history = sseData(buffer).map((data) => JSON.parse(data) as EventEnvelope)
  expect(history.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
  expect(history.at(-1)!.type).toBe('run.finished')

  await fixture.stores.events.append(fixture.runId, {
    type: 'log', actor: { type: 'system', id: 'fixture' }, data: { level: 'info', message: '实时事件' },
  })
  while (sseData(buffer).length < 11) buffer += await readChunk(reader)
  const live = JSON.parse(sseData(buffer)[10]!) as EventEnvelope
  expect(live.seq).toBe(11)
  expect(live.type).toBe('log')

  controller.abort()
  await new Promise((resolve) => setTimeout(resolve, 50))
  await fixture.stores.events.append(fixture.runId, {
    type: 'log', actor: { type: 'system', id: 'fixture' }, data: { level: 'info', message: '断开之后' },
  })
  expect((await getJson<ProjectOverview>(`${server.url}/api/project`)).status).toBe(200)

  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('SSE 连接未随请求关闭而清理，close 卡住')), 3000)
  })
  try {
    await Promise.race([server.close(), timeout])
  } finally {
    clearTimeout(timer)
  }
})

it('事件接口 types 只取指定类型、last 只取过滤后的最后 N 条', async () => {
  const fixture = await makeFixture()
  const server = await startServer({ projectDir: fixture.root })
  const url = `${server.url}/api/runs/${fixture.runId}/events`
  const all = (await getJson<EventEnvelope[]>(url)).body
  expect((await getJson<EventEnvelope[]>(`${url}?last=3`)).body.map((e) => e.seq)).toEqual(all.slice(-3).map((e) => e.seq))
  const started = (await getJson<EventEnvelope[]>(`${url}?types=node.started,run.finished`)).body
  expect(new Set(started.map((e) => e.type))).toEqual(new Set(['node.started', 'run.finished']))
  expect((await getJson<EventEnvelope[]>(`${url}?types=node.started&last=1`)).body).toEqual(started.filter((e) => e.type === 'node.started').slice(-1))
  expect((await fetch(`${url}?last=0`)).status).toBe(400)
  await server.close()
})

it('SSE ?from=tail 不回放历史，只推之后的新事件；带 after 时仍按游标补', async () => {
  const fixture = await makeFixture()
  const server = await startServer({ projectDir: fixture.root })
  const controller = new AbortController()
  const res = await fetch(`${server.url}/api/runs/${fixture.runId}/stream?from=tail`, { headers: { accept: 'text/event-stream' }, signal: controller.signal })
  expect(res.status).toBe(200)
  const reader = res.body!.getReader()
  await fixture.stores.events.append(fixture.runId, { type: 'log', actor: { type: 'system', id: 'fixture' }, data: { level: 'info', message: '新事件' } })
  let buffer = ''
  while (sseData(buffer).length < 1) buffer += await readChunk(reader)
  expect(sseData(buffer).map((data) => (JSON.parse(data) as EventEnvelope).seq)).toEqual([11])
  controller.abort()

  const resumed = new AbortController()
  const again = await fetch(`${server.url}/api/runs/${fixture.runId}/stream?from=tail&after=9`, { headers: { accept: 'text/event-stream' }, signal: resumed.signal })
  const r2 = again.body!.getReader()
  let b2 = ''
  while (sseData(b2).length < 2) b2 += await readChunk(r2)
  expect(sseData(b2).map((data) => (JSON.parse(data) as EventEnvelope).seq)).toEqual([10, 11])
  resumed.abort()
  await server.close()
})

it('回答按表单校验；重复和并发回答返回 409，回调仅执行一次', async () => {
  const { root, stores, runId, requirementId } = await makeFixture()
  let callbacks = 0
  const server = await startServer({ projectDir: root, onAnswer: () => { callbacks++ } })
  await stores.attention.create({ requestId: 'choice', runId, requirementId, nodeId: 'verify', ask: '选一个', form: 'choice', choices: ['a', 'b'] })
  await stores.attention.create({ requestId: 'answer', runId, requirementId, nodeId: 'verify', ask: '说明', form: 'answer' })
  const post = (id: string, input: unknown) => fetch(`${server.url}/api/attention/${id}`, { method: 'POST', headers: { 'x-takt-user': 'reviewer', 'content-type': 'application/json' }, body: JSON.stringify(input) })
  for (const [id, input] of [
    ['choice', { decision: 'approve' }], ['choice', { decision: 'choice', answer: 'wrong' }],
    ['att-1', { answer: 'yes' }], ['answer', { answer: ' ' }], ['answer', { decision: 'approve' }],
  ] as const) expect((await post(id, input)).status).toBe(400)
  expect(callbacks).toBe(0)
  // 失败请求不能写入任何回答或落盘记录。
  for (const id of ['choice', 'att-1', 'answer']) {
    expect((await stores.attention.list()).find((item) => item.requestId === id)!.answeredAt).toBeUndefined()
  }
  const responses = await Promise.all([post('choice', { decision: 'choice', answer: 'a' }), post('choice', { decision: 'choice', answer: 'b' })])
  expect(responses.map((response) => response.status).sort()).toEqual([200, 409])
  expect(callbacks).toBe(1)
  const answered = (await stores.attention.list()).find((item) => item.requestId === 'choice')!
  expect(answered.answeredBy).toEqual({ type: 'human', id: 'reviewer' })
  expect(answered).not.toHaveProperty('by')
  expect((await post('choice', { decision: 'choice', answer: 'a' })).status).toBe(409)
  expect(callbacks).toBe(1)
  // 409 之后持久化回答仍是首次成功的那次。
  const persisted = (await stores.attention.list()).find((item) => item.requestId === 'choice')!
  expect(persisted).toEqual(answered)
  expect(['a', 'b']).toContain(persisted.answer)
})

it('动态 prompt 经引擎和 HTTP 读回实际文本', async () => {
  const { root, stores, requirementId } = await makeFixture()
  const actual = '本轮只修复 TC-DYNAMIC，证据 evidence/TC-DYNAMIC/result.json'
  const seen: { requests: HarnessRequest[]; contexts: NodeContext[] } = { requests: [], contexts: [] }
  const harness: HarnessAdapter = {
    id: 'mock', displayName: '测试', available: async () => ({ ok: true }),
    run: async (request, onEvent) => {
      seen.requests.push(request)
      // assistant 消息只应追加，不能覆盖 user prompt。
      onEvent({ type: 'message', role: 'assistant', text: '收到，开始修复' })
      return { ok: true, finalText: 'done' }
    },
  }
  const engine = createEngine({
    stores, profiles: { dev: { role: 'dev', title: '开发', description: '', instructions: '测试角色', harness: { harness: 'mock' }, skills: [], writeScope: ['**'] } }, knowledge: [],
    harnesses: { mock: harness },
  }, { harnessOverride: 'mock' })
  const args = { ticket: 'TC-DYNAMIC', priority: 2 }
  const state = await engine.start({ requirementId, args, workflow: {
    id: 'dynamic', title: '动态', version: '1', stages: [], nodes: [
      {
        id: 'fix', kind: 'agent', title: '修复', role: 'dev',
        prompt: (ctx) => {
          seen.contexts.push(ctx)
          return actual
        },
      },
    ],
  } })
  expect(state.status).toBe('succeeded')

  // 运行时上下文：args、requirementId、workspace 实际路径都来自本次运行。
  expect(seen.contexts).toHaveLength(1)
  const ctx = seen.contexts[0]!
  expect(ctx.args).toEqual(args)
  expect(ctx.requirementId).toBe(requirementId)
  const workspaceDir = stores.workspaces.dir(requirementId)
  expect(ctx.workspaceDir).toBe(workspaceDir)
  expect(ctx.projectDir).toBe(root)

  // harness 收到的完整 prompt 才是唯一事实来源。
  expect(seen.requests).toHaveLength(1)
  const prompt = seen.requests[0]!.prompt
  expect(seen.requests[0]!.env).toMatchObject({
    TAKT_REQ: requirementId, TAKT_NODE: 'fix', TAKT_WORKSPACE: workspaceDir, TAKT_RUN_ID: state.runId,
  })
  expect(prompt).toContain(actual)
  expect(prompt.indexOf('测试角色')).toBeLessThan(prompt.indexOf(actual))
  expect(prompt).toContain(`公共存放区：${workspaceDir}`)
  expect(prompt).not.toBe(actual)

  const server = await startServer({ projectDir: root })
  const detail = await getJson<NodeDetail>(`${server.url}/api/runs/${state.runId}/nodes/fix`)
  expect(detail.status).toBe(200)
  expect(detail.body.prompt).toBe(prompt)
  const userMessages = detail.body.events.filter((event) => {
    const data = event.data as { role?: string; text?: string }
    return event.type === 'harness.message' && data.role === 'user'
  })
  expect(userMessages).toHaveLength(1)
  expect((userMessages[0]!.data as { text: string }).text).toBe(prompt)
  expect(detail.body.events.some((event) =>
    event.type === 'harness.message' && (event.data as { role: string }).role === 'assistant'
    && (event.data as { text: string }).text === '收到，开始修复')).toBe(true)
})

it('loop 多轮用量在列表、运行图、需求详情和 metrics 一致，历史删除节点仍计入总量', async () => {
  const { root, stores, requirementId, runId } = await makeFixture()
  const actor: Actor = { type: 'system', id: 'usage-test' }
  const state = (await stores.runs.get(runId))!
  state.nodes['loop/run']!.usage = { inputTokens: 999, outputTokens: 999 }
  state.nodes['loop/run']!.iteration = 2
  await stores.runs.save(state)
  const before = await readFile(join(stores.taktDir, 'runs', runId, 'state.json'), 'utf8')
  for (const iteration of [1, 2]) {
    await stores.events.append(runId, { actor, nodeId: 'loop/run', type: 'node.started', data: { attempt: 1, iteration } })
    await stores.events.append(runId, { actor, nodeId: 'loop/run', type: 'harness.usage', data: { inputTokens: 10000, outputTokens: 10000 } })
    await stores.events.append(runId, { actor, nodeId: 'loop/run', type: 'node.finished', data: { status: 'succeeded', outputs: [], usage: { inputTokens: 10 * iteration, outputTokens: 2 * iteration, cachedTokens: iteration, costUsd: 0.25 * iteration } } })
  }
  const server = await startServer({ projectDir: root })
  const total = { inputTokens: 130, outputTokens: 26, cachedTokens: 3, costUsd: 0.75 }
  const assertTotals = async (expected: typeof total) => {
    const paths = [`/api/runs?requirement=${requirementId}`, `/api/requirements/${requirementId}`, `/api/requirements/${requirementId}/metrics`, '/api/project']
    const [runs, requirement, metrics, project] = await Promise.all(paths.map(async (path) => {
      const response = await fetch(server.url + path)
      expect(response.status).toBe(200)
      return response.json()
    }))
    expect(runs[0].usage).toEqual(expected)
    expect(requirement.usage).toEqual(expected)
    expect(requirement.runs[0].usage).toEqual(expected)
    expect(metrics.usage).toEqual(expected)
    expect(project.totals.usage).toEqual(expected)
    // 迷你柱与每日活动与总量同口径（来自事件，不读节点状态里的 usage）
    const tokens = expected.inputTokens + expected.outputTokens
    expect(project.requirements[0].recentRuns).toEqual([expect.objectContaining({ runId, tokens, kind: 'workflow' })])
    expect(project.totals.daily).toHaveLength(14)
  }
  await assertTotals(total)
  const detail = await getJson<RunDetail>(`${server.url}/api/runs/${runId}`)
  expect(detail.status).toBe(200)
  expect(detail.body.graph.nodes.find((node) => node.id === 'loop/run')?.usage).toEqual({ inputTokens: 30, outputTokens: 6, cachedTokens: 3, costUsd: 0.75 })
  expect(detail.body.graph.nodes.reduce((sum, node) => sum + (node.usage?.inputTokens ?? 0), 0)).toBe(total.inputTokens)
  expect(detail.body.stages).toEqual([
    { id: 'dev', title: '研发', status: 'done', done: 1, total: 1 },
    { id: 'test', title: '测试', status: 'done', done: 3, total: 3 },
  ])
  expect(detail.body.run).toEqual(state)
  await stores.events.append(runId, { actor, nodeId: 'loop/removed', type: 'node.finished', data: { status: 'succeeded', outputs: [], usage: { inputTokens: 7, outputTokens: 1 } } })
  await assertTotals({ ...total, inputTokens: 137, outputTokens: 27 })
  const reloaded = await getJson<RunDetail>(`${server.url}/api/runs/${runId}`)
  expect(reloaded.body.run).toEqual(state)
  expect(reloaded.body.graph.nodes.some((node) => node.id === 'loop/removed')).toBe(false)
  expect(await readFile(join(stores.taktDir, 'runs', runId, 'state.json'), 'utf8')).toBe(before)
})

it('空日志通过 HTTP 返回零用量，不把持久 state 的最后一轮用量当总量', async () => {
  const { root, stores, runId } = await makeFixture()
  const state = (await stores.runs.get(runId))!
  await stores.runs.create({ ...state, runId: 'run-no-events' }, (await stores.runs.getWorkflow(runId))!)
  const server = await startServer({ projectDir: root })
  const runs = await getJson<RunSummary[]>(`${server.url}/api/runs`)
  expect(runs.body.find((run) => run.runId === 'run-no-events')?.usage).toEqual({ inputTokens: 0, outputTokens: 0 })
  const detail = await getJson<RunDetail>(`${server.url}/api/runs/run-no-events`)
  expect(detail.body.graph.nodes.every((node) => node.usage?.inputTokens === 0 && node.usage.outputTokens === 0)).toBe(true)
  expect(detail.body.run.nodes['spec-agent']!.usage).toEqual(state.nodes['spec-agent']!.usage)
})
