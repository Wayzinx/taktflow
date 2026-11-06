import { removeTestProject } from './test-cleanup.js'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { defineWorkflow, loop, planner, review, script } from '../dsl.js'
import { initProject, openProject } from '../store/project.js'
import { createEngine } from './index.js'
import { listReviews, reviewDetail } from '../insights/reviews.js'
import { buildRunGraph } from '../insights/graph.js'
import type { AgentProfile, HarnessAdapter, HarnessRequest, NodeDef, ReviewNodeDef, ReviewRecord } from '../types.js'
import { reviewPassed } from './nodes/review-schema.js'
const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => removeTestProject(root))) })
const approve = { verdict: 'approve', summary: '通过', issues: [] }
const changes = { verdict: 'request_changes', summary: '补充空名字规则', issues: [{ id: 'I1', severity: 'major', description: '缺少空名字规则' }] }
const def = (nodes: NodeDef[]) => defineWorkflow({ id: 'review', title: '交叉评审', version: '1', stages: [{ id: 's', title: '评审阶段' }], nodes })
const reviewNode = (patch: Partial<ReviewNodeDef> = {}) => review({ id: 'review', title: '评审', stage: 's', needs: ['write'], target: ['spec.md'], author: { role: 'author' }, reviewers: [{ role: 'r1', focus: '可实现性', checklist: ['覆盖 AC'] }], rubric: '完整', maxRounds: 2, onExhausted: 'fail', ...patch })
async function fixture(handler: (req: HarnessRequest) => Promise<unknown>) {
  const root = await mkdtemp(join(tmpdir(), 'takt-review-node-')); roots.push(root)
  const stores = await initProject(root)
  const requirementId = (await stores.workspaces.createRequirement({ title: '评审测试' })).id
  const calls: HarnessRequest[] = []
  const mock: HarnessAdapter = { id: 'mock', displayName: 'mock', capabilities: { structuredOutput: true }, available: async () => ({ ok: true }), run: async (req) => {
    calls.push(req); expect(req.sessionId).toBeUndefined()
    return { ok: true, finalText: '', structured: await handler(req), sessionId: `session-${calls.length}` }
  } }
  const profiles = Object.fromEntries(['author', 'r1', 'r2', 'r3'].map((role): [string, AgentProfile] => [role, { role, title: role, description: '', instructions: role, harness: { harness: 'mock' }, skills: [], writeScope: ['requirements/**'] }]))
  const deps = { stores, profiles, harnesses: { mock }, knowledge: [] }
  let writes = 0
  const write = script({ id: 'write', title: '作者', stage: 's', outputs: [{ path: 'spec.md', kind: 'spec' }], run: async (ctx) => {
    await writeFile(join(ctx.workspaceDir, 'spec.md'), `版本 ${++writes}`)
  } })
  return { stores, requirementId, deps, calls, write }
}

it.each(['all', 'majority', 'score'] as const)('通过规则 %s', (mode) => {
  const records = ['approve', 'approve', 'request_changes'].map((verdict) => ({ verdict, score: 90 })) as ReviewRecord[]
  expect(reviewPassed(records, mode === 'score' ? { minScore: 80 } : mode)).toBe(mode !== 'all')
  expect(reviewPassed([{ verdict: 'reject', score: 100 }] as ReviewRecord[], { minScore: 80 })).toBe(false)
  expect(reviewPassed([{ verdict: 'approve' }] as ReviewRecord[], { minScore: 80 })).toBe(false)
  expect(reviewPassed(records.slice(1), 'majority')).toBe(false)
})

it('独立会话评审 → 作者逐条回应 → 新版本复审；读模型和消息、审计可回读', async () => {
  let count = 0
  const f = await fixture(async (req) => {
    if (req.env!.TAKT_ROLE === 'author') {
      await writeFile(join(req.env!.TAKT_WORKSPACE!, 'spec.md'), '修订后的完整版本')
      return { responses: [{ round: 1, reviewer: 'r1', issueId: 'I1', action: 'fixed', note: '已补充' }] }
    }
    if (++count === 2) { expect(req.prompt).toContain('已补充'); expect(req.prompt).toContain('"version":2') }
    expect(req.prompt).toContain('可实现性'); expect(req.prompt).toContain('覆盖 AC'); expect(req.prompt).toContain('rubric：完整')
    return count === 1 ? changes : approve
  })
  const state = await createEngine(f.deps, { concurrency: 1 }).start({ requirementId: f.requirementId, workflow: def([f.write, reviewNode()]) })
  expect(state.status).toBe('succeeded')
  expect(state.nodes.review?.result).toEqual({ passed: true, rounds: 2 })
  const detail = await reviewDetail(await openProject(f.stores.projectDir), state.runId, 'review')
  expect(detail?.rounds).toHaveLength(2)
  expect(detail?.rounds[0]?.revised[0]?.version).toBe(2)
  expect((await listReviews(f.stores, f.requirementId))[0]).toMatchObject({ status: 'passed', round: 2, reworks: 0 })
  expect(await f.stores.events.verify(state.runId)).toEqual({ ok: true })
  const messages = await f.stores.chat.list(f.requirementId)
  expect(messages.filter((message) => message.kind === 'progress')).toHaveLength(2)
  expect(messages.some((message) => message.text === '阶段完成：评审阶段')).toBe(true)
})

it('人工拒绝触发作者修改；换引擎恢复不重复评审、不复用上一轮批准', async () => {
  let reviews = 0
  const f = await fixture(async (req) => {
    if (req.env!.TAKT_ROLE === 'author') { expect(req.prompt).toContain('补充边界'); return { responses: [] } }
    reviews++; return approve
  })
  const workflow = def([f.write, reviewNode({ humanSignoff: true })])
  const first = await createEngine(f.deps).start({ requirementId: f.requirementId, workflow })
  expect(first.status).toBe('waiting_human')
  const answer = async (decision: string) => {
    const [item] = await f.stores.attention.list({ pending: true })
    await f.stores.attention.answer(item!.requestId, { decision, answer: '补充边界', by: { type: 'human', id: 'owner' } })
  }
  await answer('reject')
  const second = await createEngine({ ...f.deps, stores: await openProject(f.stores.projectDir) }).resume(first.runId, workflow)
  expect(second.status).toBe('waiting_human'); expect(reviews).toBe(2)
  await answer('approve')
  const last = await createEngine(f.deps).resume(first.runId, workflow)
  expect(last.status).toBe('succeeded'); expect(reviews).toBe(2)
  expect(last.nodes.review?.result).toEqual({ passed: true, rounds: 2 })
  expect((await f.stores.attention.list()).map((item) => item.requestId)).toEqual([`${first.runId}:review`, `${first.runId}:review#2`])
})

it('三轮用完打回上游，保留历史、注入反馈；再次超限交人', async () => {
  const f = await fixture(async (req) => req.env!.TAKT_ROLE === 'author'
    ? { responses: [{ round: Number(/按第 (\d+) 轮/.exec(req.prompt)?.[1]), reviewer: 'r1', issueId: 'I1', action: 'deferred', note: '待重新设计' }] } : changes)
  const feedback: Array<string | undefined> = []
  const workflow = def([{ ...f.write, run: async (ctx) => { feedback.push(ctx.feedback); await writeFile(join(ctx.workspaceDir, 'spec.md'), `设计 ${feedback.length}`) } },
    script({ id: 'middle', title: '中间节点', needs: ['write'], run: async () => {} }),
    reviewNode({ needs: ['middle'], maxRounds: 3, onExhausted: { rework: 'write' } })])
  const state = await createEngine(f.deps).start({ requirementId: f.requirementId, workflow })
  expect(state.status).toBe('waiting_human')
  expect(state.nodes.write?.reworks).toBe(1)
  expect(feedback).toHaveLength(2); expect(feedback[1]).toContain('缺少空名字规则')
  const events = await f.stores.events.read(state.runId, { types: ['rework.started'] })
  expect(events).toHaveLength(1)
  expect(events[0]?.data).toMatchObject({ reset: ['write', 'middle', 'review'] })
  expect((await reviewDetail(f.stores, state.runId, 'review'))?.rounds).toHaveLength(6)
  expect(buildRunGraph((await f.stores.runs.getWorkflow(state.runId))!, state).edges).toContainEqual({ from: 'review', to: 'write', kind: 'route', label: '打回' })
  const [item] = await f.stores.attention.list({ pending: true })
  expect(item?.choices).toEqual(['放行', '打回', '终止'])
  await f.stores.attention.answer(item!.requestId, { decision: 'choice', answer: '放行', by: { type: 'human', id: 'owner' } })
  expect((await createEngine(f.deps).resume(state.runId, workflow)).status).toBe('succeeded')
})

it.each(['fail', 'terminate', 'retry', 'invalid', 'missing-response'] as const)('评审边界：%s', async (mode) => {
  let reviews = 0
  const f = await fixture(async (req) => {
    if (req.env!.TAKT_ROLE === 'author') return { responses: [] }
    reviews++
    return mode === 'invalid' ? { verdict: 'not-a-verdict', summary: '', issues: [] } : mode === 'retry' && reviews > 1 ? approve : changes
  })
  const workflow = def([f.write, reviewNode({ maxRounds: mode === 'missing-response' ? 2 : 1, onExhausted: mode === 'terminate' || mode === 'retry' ? 'human' : 'fail' })])
  const first = await createEngine(f.deps).start({ requirementId: f.requirementId, workflow })
  if (mode === 'terminate' || mode === 'retry') {
    expect(first.status).toBe('waiting_human')
    const [item] = await f.stores.attention.list({ pending: true })
    await f.stores.attention.answer(item!.requestId, { decision: 'choice', answer: mode === 'retry' ? '打回' : '终止', by: { type: 'human', id: 'owner' } })
    // retry 的作者故意缺回应，仍然 fail-closed。
    expect((await createEngine(f.deps).resume(first.runId, workflow)).status).toBe('failed')
  } else expect(first.status).toBe('failed')
})

it('planner 内 review 的打回限定本 item；换实例恢复', async () => {
  let reviewed = 0
  const f = await fixture(async (req) => req.env!.TAKT_NODE === 'plan'
    ? { items: [{ key: 'one', title: '任务' }] } : ++reviewed === 1 ? changes : approve)
  const workflow = def([planner({ id: 'plan', title: '拆分', role: 'author', prompt: '拆分', maxItems: 1, expand: () => [f.write,
    reviewNode({ maxRounds: 1, onExhausted: { rework: 'write' }, humanSignoff: true })] })])
  const first = await createEngine(f.deps, { concurrency: 1 }).start({ requirementId: f.requirementId, workflow })
  expect(first.status).toBe('waiting_human')
  expect(first.nodes['plan/one/write']?.reworks).toBe(1)
  const [item] = await f.stores.attention.list({ pending: true })
  await f.stores.attention.answer(item!.requestId, { decision: 'approve', by: { type: 'human', id: 'owner' } })
  expect((await createEngine(f.deps).resume(first.runId, workflow)).status).toBe('succeeded')
  const detail = await reviewDetail(f.stores, first.runId, 'plan/one/review')
  expect(detail?.rounds).toHaveLength(2)
})

it('静态校验拒绝非法打回目标、空评审者和零轮次；运行时校验作者角色', async () => {
  expect(() => def([reviewNode({ needs: [], reviewers: [] })])).toThrow('reviewers')
  expect(() => def([filler(), reviewNode({ maxRounds: 0 })])).toThrow('maxRounds')
  expect(() => def([filler(), reviewNode({ onExhausted: { rework: 'missing' } })])).toThrow('上游')
  expect(() => def([filler(), reviewNode({ needs: [], onExhausted: { rework: 'write' } })])).toThrow('上游')
  const f = await fixture(async () => approve)
  await expect(createEngine(f.deps).start({ requirementId: f.requirementId, workflow: def([f.write, reviewNode({ author: { role: 'missing' } })]) })).rejects.toThrow('角色不存在')
  function filler() { return script({ id: 'write', title: '', run: async () => {} }) }
})

it('人工确认后仍保留输入版本；产物变更后 stale 恢复必须重新评审', async () => {
  let reviews = 0
  const f = await fixture(async () => { reviews++; return approve })
  const workflow = def([f.write, reviewNode({ humanSignoff: true })])
  const engine = createEngine(f.deps, { autoApprove: true })
  const first = await engine.start({ requirementId: f.requirementId, workflow })
  expect(first.status).toBe('succeeded')
  expect(first.nodes.review?.inputs).toEqual([{ workspace: f.requirementId, path: 'spec.md', version: 1 }])
  const ref = await f.stores.workspaces.writeArtifact({ ref: { workspace: f.requirementId, path: 'spec.md' }, content: '人工新版', kind: 'spec', author: { type: 'human', id: 'owner' }, reason: '改版' })
  expect(await engine.markStale(first.runId, ref)).toContain('review')
  const last = await createEngine(f.deps, { autoApprove: true }).resume(first.runId, workflow)
  expect(last.status).toBe('succeeded')
  expect(reviews).toBe(2)
  expect(last.nodes.review?.inputs?.[0]?.version).toBe(2)
  expect((await reviewDetail(f.stores, first.runId, 'review'))?.rounds).toHaveLength(2)
})

it('loop 每轮重建独立评审，不能复用上一轮通过状态', async () => {
  let reviews = 0
  const f = await fixture(async () => { reviews++; return approve })
  const workflow = def([loop({ id: 'cycle', title: '循环', maxIterations: 2, until: (ctx) => ctx.iteration === 2, body: [f.write, reviewNode()] })])
  const state = await createEngine(f.deps).start({ requirementId: f.requirementId, workflow })
  expect(state.status).toBe('succeeded'); expect(reviews).toBe(2)
  expect((await reviewDetail(f.stores, state.runId, 'cycle/review'))?.rounds).toHaveLength(2)
})

it('评审 harness 覆盖与运行参数被写入快照，代码评审过滤其他运行及仓库 diff', async () => {
  const f = await fixture(async (req) => {
    expect(req.prompt).toContain('tasks/app.diff')
    expect(req.prompt).not.toContain('tasks/other.diff')
    expect(req.prompt).toContain('main~1')
    return approve
  })
  f.stores.config.repos = [{ id: 'app', path: '.', defaultBranch: 'main' }]
  const other = { ...f.deps.harnesses.mock, id: 'other' }
  let overrideCalls = 0
  other.run = async (req, onEvent) => { overrideCalls++; return f.deps.harnesses.mock.run(req, onEvent) }
  const workflow = def([script({ id: 'write', title: 'diff', outputs: [{ path: 'tasks/*.diff', kind: 'code-change' }], run: async (ctx) => {
    const { mkdir } = await import('node:fs/promises')
    await mkdir(join(ctx.workspaceDir, 'tasks'), { recursive: true })
    await writeFile(join(ctx.workspaceDir, 'tasks/app.diff'), 'current app diff')
  } }), reviewNode({ target: { code: { repo: 'app', base: 'main~1' } }, reviewers: [{ role: 'r1', harness: { harness: 'other' } }], onExhausted: { rework: 'write' } })])
  await f.stores.workspaces.writeArtifact({ ref: { workspace: f.requirementId, path: 'tasks/other.diff' }, content: 'old diff', kind: 'code-change', author: { type: 'system', id: 'test' }, producedBy: { runId: 'run-old', nodeId: 'write' } })
  // 旧 diff 已登记但不应作为本次 script 的输出重新归属。
  const writer = workflow.nodes[0]!
  writer.outputs = [{ path: 'tasks/app.diff', kind: 'code-change' }]
  const state = await createEngine({ ...f.deps, harnesses: { mock: f.deps.harnesses.mock, other } }).start({ requirementId: f.requirementId, workflow,
    args: { review: { maxRounds: 4, maxReworks: 2, humanSignoff: false } } })
  expect(state.status).toBe('succeeded'); expect(overrideCalls).toBe(1)
  expect((await f.stores.runs.getWorkflow(state.runId))?.nodes[1]?.review).toMatchObject({ maxRounds: 4, humanSignoff: false, onExhausted: { rework: 'write', maxReworks: 2 } })
})

it('同内容 diff 在下一运行复用版本仍可评审；作者修订 diff 后第二轮正确读取', async () => {
  let reviewed = 0
  const f = await fixture(async (req) => {
    if (req.env!.TAKT_ROLE === 'author') {
      await writeFile(join(req.env!.TAKT_WORKSPACE!, 'tasks/app.diff'), 'revised diff')
      return { responses: [{ round: 1, reviewer: 'r1', issueId: 'I1', action: 'fixed', note: '修复' }] }
    }
    return ++reviewed === 1 ? changes : approve
  })
  // 脚本方式产出不依赖真正的代码 harness，记录唯一 app 仓库绑定。
  f.stores.config.repos = [{ id: 'app', path: '.', defaultBranch: 'main' }]
  const workflow = def([script({ id: 'write', title: '开发', outputs: [{ path: 'tasks/app.diff', kind: 'code-change' }], run: async (ctx) => {
    const { mkdir } = await import('node:fs/promises')
    await mkdir(join(ctx.workspaceDir, 'tasks'), { recursive: true })
    await writeFile(join(ctx.workspaceDir, 'tasks/app.diff'), reviewed ? 'revised diff' : 'initial diff')
  } }), reviewNode({ target: { code: { repo: 'app' } } })])
  const engine = createEngine(f.deps)
  expect((await engine.start({ requirementId: f.requirementId, workflow })).status).toBe('succeeded')
  const next = await engine.start({ requirementId: f.requirementId, workflow })
  expect(next.status).toBe('succeeded'); expect(reviewed).toBe(3)
  expect((await reviewDetail(f.stores, next.runId, 'review'))?.rounds).toHaveLength(1)
})

it('相同时间与相同内容的重评不丢历史；人裁决打回后可完成新一轮', async () => {
  let calls = 0
  const f = await fixture(async (req) => req.env!.TAKT_ROLE === 'author'
    ? { responses: [{ round: 1, reviewer: 'r1', issueId: 'I1', action: 'fixed', note: '完成' }] }
    : ++calls <= 2 ? changes : approve)
  const workflow = def([f.write, reviewNode({ maxRounds: 1, onExhausted: 'human' })])
  const options = { now: () => new Date('2026-11-01T00:00:00Z') }
  let state = await createEngine(f.deps, options).start({ requirementId: f.requirementId, workflow })
  for (let i = 0; i < 2; i++) {
    const [item] = await f.stores.attention.list({ pending: true })
    await f.stores.attention.answer(item!.requestId, { decision: 'choice', answer: '打回', by: { type: 'human', id: 'owner' } })
    state = await createEngine(f.deps, options).resume(state.runId, workflow)
  }
  expect(state.status).toBe('succeeded')
  expect((await reviewDetail(f.stores, state.runId, 'review'))?.rounds).toHaveLength(3)
})

it('打回意见注入 agent prompt；重新生成后通过并保留两轮历史', async () => {
  let writes = 0
  let reviews = 0
  const f = await fixture(async (req) => {
    if (req.env!.TAKT_NODE === 'write') {
      if (++writes === 2) expect(req.prompt).toContain('上一次评审未通过，意见如下：')
      await writeFile(join(req.env!.TAKT_WORKSPACE!, 'spec.md'), `第 ${writes} 次产出`)
      return '完成'
    }
    return ++reviews === 1 ? changes : approve
  })
  const { agent } = await import('../dsl.js')
  const workflow = def([agent({ id: 'write', title: '作者', role: 'author', prompt: '编写 spec', outputs: [{ path: 'spec.md', kind: 'spec' }] }),
    reviewNode({ maxRounds: 1, onExhausted: { rework: 'write', maxReworks: 1 } })])
  const state = await createEngine(f.deps).start({ requirementId: f.requirementId, workflow })
  expect(state.status).toBe('succeeded'); expect(writes).toBe(2)
  expect((await reviewDetail(f.stores, state.runId, 'review'))?.rounds).toHaveLength(2)
})
