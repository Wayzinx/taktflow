import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { agent, gate, human, judge, loop, planner, script } from '../dsl.js'
import type { EngineDeps } from '../interfaces.js'
import type { Actor, EventEnvelope, HarnessAdapter, HarnessRequest, Lesson, NodeDef, WorkflowDefinition } from '../types.js'
import { initProject } from '../store/project.js'
import { snapshotWorkflow } from '../store/snapshot.js'
import { createEngine } from './index.js'

const roots: string[] = []
const by: Actor = { type: 'human', id: 'tester' }
const workflow = (nodes: NodeDef[]): WorkflowDefinition => ({ id: 'm3-engine', title: '引擎纪律', version: '1', stages: [], nodes })
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))) })

// 引擎单测使用事件端口假实现；真实 FsEventStore 的新事件白名单属于接入任务。
async function fixture(run: HarnessAdapter['run'] = async () => ({ ok: true, finalText: '完成' })) {
  const root = await mkdtemp(join(tmpdir(), 'takt-m3-engine-')); roots.push(root)
  const stores = await initProject(root)
  const requirementId = (await stores.workspaces.createRequirement({ title: 'M3' })).id
  const events: EventEnvelope[] = []
  vi.spyOn(stores.events, 'append').mockImplementation(async (runId, input) => {
    const event = { ...input, runId, seq: events.length + 1, ts: new Date().toISOString(), hash: '', prevHash: '' } as EventEnvelope
    events.push(event)
    return event as never
  })
  vi.spyOn(stores.events, 'read').mockImplementation(async (runId, filter) => events.filter((event) => event.runId === runId &&
    (!filter?.nodeId || event.nodeId === filter.nodeId) && (!filter?.types || filter.types.includes(event.type))))
  const calls: HarnessRequest[] = []
  const harness: HarnessAdapter = { id: 'mock', displayName: 'mock', capabilities: { usage: true, structuredOutput: true }, available: async () => ({ ok: true }),
    run: async (request, emit) => { calls.push(request); return run(request, emit) } }
  const deps: EngineDeps = { stores, knowledge: [], harnesses: { mock: harness }, profiles: Object.fromEntries(['dev', 'qa', 'verifier'].map((role) => [role,
    { role, title: role, description: '', instructions: `角色 ${role}`, harness: { harness: 'mock' }, skills: ['test'], writeScope: ['**'] }])) }
  const write = async (path: string, content: string, kind: 'spec' | 'case' | 'evidence' | 'input' = 'input') => stores.workspaces.writeArtifact({
    ref: { workspace: requirementId, path }, content, kind, author: by, reason: '测试输入',
  })
  return { root, stores, requirementId, events, calls, deps, write }
}
const writeText = async (root: string, path: string, text: string) => { await mkdir(dirname(join(root, path)), { recursive: true }); await writeFile(join(root, path), text) }
const checks = [{ id: 'c1', criterion: '测试必须全部通过', pass: true, evidence: 'test.log: passed' }]

it('并发 strict 节点各自声明的输出不会被另一个节点隔离', async () => {
  let arrive!: () => void, release!: () => void
  const firstReady = new Promise<void>((resolve) => { arrive = resolve })
  const secondReady = new Promise<void>((resolve) => { release = resolve })
  const f = await fixture(async (req) => {
    const id = req.env!.TAKT_NODE!
    if (id === 'a') { arrive(); await secondReady }
    else { await firstReady; release() }
    await writeText(req.env!.TAKT_WORKSPACE!, `${id}.txt`, id)
    return { ok: true, finalText: '完成' }
  })
  const state = await createEngine(f.deps).start({ requirementId: f.requirementId, workflow: workflow(['a', 'b'].map((id) =>
    agent({ id, title: '', role: 'dev', prompt: '', strictOutputs: true, outputs: [{ path: `${id}.txt`, kind: 'report' }] }))) })
  expect(state.status).toBe('succeeded')
  expect(f.events.filter((event) => event.type === 'guard.violation')).toEqual([])
  expect(await readFile(join(f.stores.workspaces.dir(f.requirementId), 'a.txt'), 'utf8')).toBe('a')
  expect(await readFile(join(f.stores.workspaces.dir(f.requirementId), 'b.txt'), 'utf8')).toBe('b')
})

it('strict 执行期间发生人工改版，保留人工版本而非隔离', async () => {
  const f = await fixture(async () => { await f.write('human.txt', '人工新版本'); return { ok: true, finalText: '完成' } })
  await f.write('human.txt', '人工旧版本')
  const state = await createEngine(f.deps).start({ requirementId: f.requirementId, workflow: workflow([
    agent({ id: 'a', title: '', role: 'dev', prompt: '', strictOutputs: true }),
  ]) })
  expect(state.status).toBe('succeeded')
  expect(await readFile(join(f.stores.workspaces.dir(f.requirementId), 'human.txt'), 'utf8')).toBe('人工新版本')
  expect(f.events.filter((event) => event.type === 'guard.violation')).toEqual([])
})

it('有新版本的输入不会触发旧失败抑制，且阈值支持配置', async () => {
  const f = await fixture(async () => { await f.write('input.txt', `version-${f.calls.length}`); return { ok: false, finalText: '', error: '同样失败' } })
  await f.write('input.txt', 'v0')
  f.stores.config.retry = { maxSameFailure: 3 }
  const state = await createEngine(f.deps).start({ requirementId: f.requirementId, workflow: workflow([
    agent({ id: 'a', title: '', role: 'dev', prompt: '', inputs: [{ path: 'input.txt' }], retry: { max: 3 } }),
  ]) })
  expect(f.calls).toHaveLength(4)
  expect(state.nodes.a?.failures?.map((failure) => failure.count)).toEqual([1, 1, 1, 1])
  expect(f.events.some((event) => event.type === 'retry.suppressed')).toBe(false)
})

it('费用到 80% 先告警，未耗尽时继续执行；用量为本次运行事件累计', async () => {
  const f = await fixture(async (_req, emit) => { emit({ type: 'usage', usage: { inputTokens: 1, outputTokens: 1, costUsd: 0.4 } }); return { ok: true, finalText: '完成' } })
  const state = await createEngine(f.deps, { concurrency: 1 }).start({ requirementId: f.requirementId, budget: { costUsd: 1 }, workflow: workflow([
    agent({ id: 'a', title: '', role: 'dev', prompt: '' }), agent({ id: 'b', title: '', role: 'dev', prompt: '' }),
    script({ id: 'end', title: '', needs: ['a', 'b'], run: async () => {} }),
  ]) })
  expect(state.status).toBe('succeeded')
  expect(f.events.filter((event) => event.type === 'budget.warning')).toHaveLength(1)
  expect(f.events.find((event) => event.type === 'budget.warning')?.data).toMatchObject({ used: { tokens: 4, costUsd: 0.8 }, ratio: 0.8 })
  expect(f.events.some((event) => event.type === 'budget.exhausted')).toBe(false)
})

describe('完成标准与输出契约', () => {
  it.each([true, false])('即使进程正常退出也按完成标准判定，pass=%s', async (pass) => {
    const f = await fixture(async () => ({ ok: true, finalText: '最终消息\n第二行', structured: { checks: [{ ...checks[0], pass }], summary: '测'.repeat(90) } }))
    const state = await createEngine(f.deps).start({ requirementId: f.requirementId, workflow: workflow([agent({ id: 'a', title: '实现', role: 'dev', prompt: '实现', completion: [checks[0]!.criterion] })]) })
    expect(state.nodes.a?.status).toBe(pass ? 'succeeded' : 'failed')
    expect(state.nodes.a?.summary).toHaveLength(80)
    expect(state.nodes.a?.checks?.[0]?.pass).toBe(pass)
    expect(f.events.find((event) => event.type === 'node.checks')?.data).toMatchObject({ unmet: pass ? [] : ['c1'] })
    expect(f.calls[0]?.resultSchema).toMatchObject({ required: ['checks'] })
    expect(f.calls[0]?.prompt).toContain('完成标准（逐条自检）')
  })
  it('没有 completion 和 schema 保持自由文本；完成标准缺失必须失败', async () => {
    const f = await fixture()
    const state = await createEngine(f.deps).start({ requirementId: f.requirementId, workflow: workflow([
      agent({ id: 'free', title: '', role: 'dev', prompt: '' }),
      agent({ id: 'strict', title: '', role: 'dev', prompt: '', completion: [checks[0]!.criterion] }),
    ]) })
    expect(state.nodes.free).toMatchObject({ status: 'succeeded', summary: '完成', result: '完成' })
    expect(state.nodes.strict?.error).toBe('完成标准未满足：c1')
  })
  it.each([true, false])('未声明的新文件与修改文件：strict=%s', async (strictOutputs) => {
    const f = await fixture(async (req) => {
      await writeText(req.env!.TAKT_WORKSPACE!, 'cache/new.txt', '缓存')
      await writeText(req.env!.TAKT_WORKSPACE!, 'draft.txt', '修改草稿')
      await writeText(req.env!.TAKT_WORKSPACE!, 'out.txt', '正式产物')
      return { ok: true, finalText: '完成' }
    })
    await f.write('draft.txt', '原草稿')
    const state = await createEngine(f.deps).start({ requirementId: f.requirementId, workflow: workflow([agent({ id: 'a', title: '', role: 'dev', prompt: '', strictOutputs, outputs: [{ path: 'out.txt', kind: 'report' }] })]) })
    expect(state.status).toBe('succeeded')
    const dir = f.stores.workspaces.dir(f.requirementId)
    expect(await readFile(join(dir, 'out.txt'), 'utf8')).toBe('正式产物')
    if (strictOutputs) {
      expect(await readFile(join(f.stores.taktDir, 'quarantine', state.runId, 'a/cache/new.txt'), 'utf8')).toBe('缓存')
      expect(await readFile(join(f.stores.taktDir, 'quarantine', state.runId, 'a/draft.txt'), 'utf8')).toBe('修改草稿')
      expect(await readFile(join(dir, 'draft.txt'), 'utf8')).toBe('原草稿')
      await expect(readFile(join(dir, 'cache/new.txt'))).rejects.toThrow()
      expect(f.events.find((event) => event.type === 'guard.violation')?.data).toMatchObject({ rule: 'output-contract', action: 'reverted' })
    } else expect(f.events.filter((event) => event.type === 'artifact.untracked')).toHaveLength(2)
  })
})

describe('失败指纹与恢复', () => {
  it('默认第二次同样失败即 blocked；换引擎后选择再试一次清零并实际重跑', async () => {
    let calls = 0
    const f = await fixture(async () => ++calls < 3 ? { ok: false, finalText: '', error: 'exit 7' } : { ok: true, finalText: '完成' })
    const def = workflow([agent({ id: 'a', title: '', role: 'dev', prompt: '', retry: { max: 5 } })])
    let state = await createEngine(f.deps).start({ requirementId: f.requirementId, workflow: def })
    expect(calls).toBe(2)
    expect(state.nodes.a).toMatchObject({ status: 'blocked', failures: [{ code: 'exit:7', count: 2 }] })
    expect(state.status).toBe('waiting_human')
    const item = (await f.stores.attention.list({ pending: true }))[0]!
    expect(item).toMatchObject({ kind: 'retry', choices: ['再试一次', '交给人处理', '终止运行'] })
    await f.stores.attention.answer(item.requestId, { decision: 'choice', answer: '再试一次', by })
    state = await createEngine(f.deps).resume(state.runId, def)
    expect(state.nodes.a).toMatchObject({ status: 'succeeded', failures: [{ count: 0 }] })
    expect(calls).toBe(3)
  })
  it.each(['交给人处理', '终止运行'])('重复失败的人工选择：%s', async (answer) => {
    const f = await fixture(async () => { throw new Error('相同失败') })
    const def = workflow([agent({ id: 'a', title: '', role: 'dev', prompt: '', retry: { max: 4 } })])
    const state = await createEngine(f.deps).start({ requirementId: f.requirementId, workflow: def })
    await f.stores.attention.answer((await f.stores.attention.list({ pending: true }))[0]!.requestId, { decision: 'choice', answer, by })
    const resumed = await createEngine(f.deps).resume(state.runId, def)
    expect(f.calls).toHaveLength(2)
    expect(resumed.nodes.a?.status).toBe(answer === '终止运行' ? 'cancelled' : 'blocked')
  })
  it('失败门禁按检查 id 计数并抑制；自检使用 completion.unmet', async () => {
    const f = await fixture(async () => ({ ok: true, finalText: '', structured: {} }))
    const state = await createEngine(f.deps).start({ requirementId: f.requirementId, workflow: workflow([
      gate({ id: 'g', title: '', retry: { max: 5 }, checks: [{ id: 'tests', kind: 'function', fn: async () => ({ id: 'tests', pass: false }) }] }),
      agent({ id: 'a', title: '', role: 'dev', prompt: '', completion: [checks[0]!.criterion], retry: { max: 5 } }),
    ]) })
    expect(state.nodes.g?.failures).toMatchObject([{ code: 'gate:tests', count: 2 }])
    expect(state.nodes.a?.failures).toMatchObject([{ code: 'completion.unmet', count: 2 }])
    expect(f.events.filter((event) => event.type === 'retry.suppressed')).toHaveLength(2)
  })
  it.each(['product_bug', 'flaky'])('Loop 跨轮次保留判决指纹，flaky 豁免：%s', async (category) => {
    const f = await fixture(async () => ({ ok: true, finalText: '', structured: { verdicts: [{ subject: 'TC-1', category, confidence: 1, rationale: '失败', evidence: ['log'] }] } }))
    let fixes = 0
    const state = await createEngine(f.deps).start({ requirementId: f.requirementId, workflow: workflow([loop({
      id: 'cycle', title: '', maxIterations: 4, onExhausted: 'fail', until: () => false,
      body: [script({ id: 'run', title: '', run: async () => ({ data: { failures: [{ subject: 'TC-1' }] } }) }),
        judge({ id: 'judge', title: '', role: 'qa', target: 'run', needs: ['run'], routes: { product_bug: 'fix', flaky: 'fix' } }),
        script({ id: 'fix', title: '', needs: ['judge'], run: async () => { fixes++ } })],
    })]) })
    expect(f.calls).toHaveLength(category === 'flaky' ? 4 : 2)
    expect(fixes).toBe(category === 'flaky' ? 4 : 1)
    expect(state.nodes.cycle?.status).toBe('failed')
    expect(f.events.some((event) => event.type === 'retry.suppressed')).toBe(category !== 'flaky')
  })
  it('Loop 失败执行没有 judge 也在相同输入第二次时按 onExhausted 提前交人', async () => {
    const f = await fixture()
    const state = await createEngine(f.deps).start({ requirementId: f.requirementId, workflow: workflow([loop({ id: 'cycle', title: '', maxIterations: 6, until: () => false,
      body: [script({ id: 'test', title: '', run: async () => ({ data: { failures: [{ subject: 'TC-1' }] } }) })],
    })]) })
    expect(state.nodes.cycle?.iteration).toBe(2)
    expect(state.status).toBe('waiting_human')
    expect(await f.stores.attention.list({ pending: true })).toHaveLength(1)
  })
  it.each(['test_data', 'deployment', 'permission', 'external_dependency'])('新判决类别未配置路由时交人：%s', async (category) => {
    const f = await fixture(async () => ({ ok: true, finalText: '', structured: { verdicts: [{ subject: 'TC-1', category, confidence: 1, rationale: '环境', evidence: ['log'] }] } }))
    const state = await createEngine(f.deps).start({ requirementId: f.requirementId, workflow: workflow([
      script({ id: 'test', title: '', run: async () => ({ data: { failures: [{ subject: 'TC-1' }] } }) }),
      judge({ id: 'j', title: '', role: 'qa', target: 'test', needs: ['test'], routes: {} }),
    ]) })
    expect(state.nodes.j?.status).toBe('waiting_human')
    expect(f.events.find((event) => event.type === 'judge.verdict')?.data).toMatchObject({ routed: [{ to: 'human' }] })
  })
})

it('分钟预算在长脚本执行中发出通知，已运行的脚本正常收尾', async () => {
  let now = 0
  const f = await fixture()
  const state = await createEngine(f.deps, { now: () => new Date(now) }).start({ requirementId: f.requirementId, budget: { minutes: 0.001 }, workflow: workflow([
    script({ id: 'long', title: '', run: async () => {
      now = 100
      await new Promise((resolve) => setTimeout(resolve, 100))
      expect(f.events.some((event) => event.type === 'budget.exhausted')).toBe(true)
    } }),
    script({ id: 'after', title: '', needs: ['long'], run: async () => { throw new Error('不应执行') } }),
  ]) })
  expect(state.nodes.long?.status).toBe('succeeded')
  expect(state.nodes.after?.status).toBe('pending')
  expect(state.status).toBe('waiting_human')
})

describe('预算、派发与挂点', () => {
  it('合并预算、80% 告警一次、100% 停新节点；追加后恢复且不重复追加', async () => {
    const f = await fixture(async (_req, emit) => { emit({ type: 'usage', usage: { inputTokens: 40, outputTokens: 10, costUsd: 0.1 } }); return { ok: true, finalText: '完成' } })
    f.stores.config.budget = { tokens: 200, costUsd: 10, concurrency: 3 }
    const def = { ...workflow(['a', 'b', 'c'].map((id, index) => agent({ id, title: '', role: 'dev', prompt: '', needs: index ? [['a', 'b'][index - 1]!] : [] }))), budget: { tokens: 100, concurrency: 1 } }
    let state = await createEngine(f.deps, { concurrency: 4 }).start({ requirementId: f.requirementId, workflow: def, budget: { minutes: 60 } })
    expect(state.budget).toEqual({ tokens: 100, costUsd: 10, concurrency: 1, minutes: 60 })
    expect(f.calls).toHaveLength(2)
    expect(state.nodes.c?.status).toBe('pending')
    expect(state.status).toBe('waiting_human')
    expect(f.events.filter((event) => event.type === 'budget.warning')).toHaveLength(1)
    expect(f.events.filter((event) => event.type === 'budget.exhausted')).toHaveLength(1)
    await f.stores.attention.answer((await f.stores.attention.list({ pending: true }))[0]!.requestId, { decision: 'choice', answer: '追加 50% 预算', by })
    state = await createEngine(f.deps).resume(state.runId, def)
    expect(f.calls).toHaveLength(3)
    expect(state.budget?.tokens).toBe(150)
    await createEngine(f.deps).resume(state.runId, def)
    expect((await f.stores.runs.get(state.runId))?.budget?.tokens).toBe(150)
  })
  it('预算并发限制与分钟耗尽，排队节点不启动，停止运行生效', async () => {
    let now = 0, active = 0, peak = 0
    const f = await fixture(async () => { active++; peak = Math.max(peak, active); now = 120000; active--; return { ok: true, finalText: '完成' } })
    const def = workflow(['a', 'b', 'c'].map((id) => agent({ id, title: '', role: 'dev', prompt: '' })))
    const state = await createEngine(f.deps, { now: () => new Date(now), concurrency: 4 }).start({ requirementId: f.requirementId, workflow: def, budget: { concurrency: 1, minutes: 1 } })
    expect(peak).toBe(1); expect(f.calls).toHaveLength(1)
    expect(state.nodes.b?.status).toBe('pending')
    const item = (await f.stores.attention.list({ pending: true }))[0]!
    await f.stores.attention.answer(item.requestId, { decision: 'choice', answer: '停止运行', by })
    expect((await createEngine(f.deps).resume(state.runId, def)).status).toBe('cancelled')
  })
  it('human 待办绑定精确输入版本并按职责分派；启动元数据与路由事件落盘', async () => {
    const f = await fixture()
    f.stores.config.members = [{ id: 'qa-user', name: 'QA', role: 'member', duties: ['qa'] }, { id: 'dev-user', name: 'Dev', role: 'member', duties: ['rd'] }]
    const ref = await f.write('spec.txt', '规格')
    const route = { tier: 'T1' as const, workflowId: 'm3-engine', reason: '一个改动面', surfaces: [], gates: [], roles: ['qa'], decidedBy: by, at: new Date().toISOString() }
    const origin = { kind: 'chat' as const, messageId: 'msg', by, title: '任务' }
    const state = await createEngine(f.deps).start({ requirementId: f.requirementId, route, kind: 'task', origin, workflow: workflow([
      human({ id: 'h', title: '', goal: '确认范围', owner: 'qa', ask: '确认', form: 'approve', inputs: [{ path: 'spec.txt' }] }),
    ]) })
    expect((await f.stores.attention.list())[0]).toMatchObject({ owner: 'qa', assignees: ['qa-user'], boundTo: [ref] })
    expect(state).toMatchObject({ route, kind: 'task', origin })
    expect(f.events.find((event) => event.type === 'route.decided')?.data).toEqual(route)
    expect((await f.stores.runs.getWorkflow(state.runId))?.nodes[0]).toMatchObject({ goal: '确认范围', owner: 'qa' })
  })
  it('prompt 稳定前缀不受最后反馈变化影响；经验召回进入上下文，只为首次执行记账', async () => {
    let count = 0
    const f = await fixture(async () => ++count === 1 ? { ok: false, finalText: '', error: '第一次失败' } : { ok: true, finalText: '完成' })
    const lesson = { id: 'lesson-1' } as Lesson
    const record = vi.fn(async () => [{ id: lesson.id, status: 'active' as const, reason: '更新', stats: { recalled: 1, helped: 1, hurt: 0 } }])
    const recall = vi.fn(async () => ({ lessons: [lesson], holdout: false, text: '验证结果后再交付', tokens: 8 }))
    f.deps.lessons = { recall, record }
    const state = await createEngine(f.deps).start({ requirementId: f.requirementId, workflow: workflow([agent({ id: 'a', title: '', role: 'dev', prompt: '实现功能', retry: { max: 1 } })]) })
    expect(state.status).toBe('succeeded')
    expect(f.calls[1]?.prompt.split('\n\n上一次失败原因：')[0]).toBe(f.calls[0]?.prompt)
    expect(f.calls[0]?.systemAppend).toBe('角色 dev')
    expect(f.calls[0]!.prompt.indexOf('技能清单')).toBeLessThan(f.calls[0]!.prompt.indexOf('经验：'))
    expect(f.calls[0]!.prompt.indexOf('经验：')).toBeLessThan(f.calls[0]!.prompt.indexOf('实现功能'))
    expect((await f.stores.runs.getContext(state.runId, 'a')).snapshots[0]?.items.some((item) => item.source === 'lesson')).toBe(true)
    expect(record).toHaveBeenCalledTimes(1)
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'hurt' }))
    expect(f.events.some((event) => event.type === 'lesson.updated')).toBe(true)
  })
  it('对照组只记召回、不注入文本；真实节点产物缺失算 hurt', async () => {
    const f = await fixture()
    const record = vi.fn(async () => [])
    f.deps.lessons = { recall: async () => ({ lessons: [{ id: 'trial' } as Lesson], holdout: true, text: '不得注入', tokens: 4 }), record }
    await createEngine(f.deps).start({ requirementId: f.requirementId, workflow: workflow([agent({ id: 'a', title: '', role: 'dev', prompt: '', outputs: [{ path: 'missing.txt', kind: 'report' }] })]) })
    expect(f.calls[0]?.prompt).not.toContain('不得注入')
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ holdout: true, outcome: 'hurt' }))
  })
  it.each([true, false])('worktree bootstrap=%s，失败必须 blocked 且不调用 harness', async (ok) => {
    const f = await fixture()
    f.deps.repos = { createWorktree: async () => {
      if (!ok) throw new Error('npm ci 失败')
      return { path: f.root, base: 'HEAD', branch: 'test', bootstrap: { command: 'bootstrap', shared: ['node_modules'], ok: true, ms: 10 } }
    }, diff: async () => ({ files: [], patch: '' }), removeWorktree: async () => {}, mirror: async () => ({ path: f.root }) } as unknown as EngineDeps['repos']
    const state = await createEngine(f.deps).start({ requirementId: f.requirementId, workflow: workflow([agent({ id: 'a', title: '', role: 'dev', prompt: '', repo: 'app' })]) })
    expect(f.calls).toHaveLength(ok ? 1 : 0)
    expect(state.nodes.a?.status).toBe(ok ? 'succeeded' : 'blocked')
    expect(f.events.some((event) => event.type === 'worktree.bootstrapped')).toBe(ok)
  })
  it('planner 有交集的条目加依赖，恢复后沿用；互不相交的条目不加依赖', async () => {
    const f = await fixture(async (req) => ({ ok: true, finalText: '', structured: req.env?.TAKT_NODE === 'plan' ? { items: [{ key: 'a', title: 'a' }, { key: 'b', title: 'b' }, { key: 'c', title: 'c' }] } : undefined }))
    const def = workflow([planner({ id: 'plan', title: '', role: 'dev', prompt: '', maxItems: 3, expand: (item) => [
      agent({ id: 'code', title: '', role: 'dev', prompt: '', writeScope: [item.key === 'c' ? 'docs/**' : 'src/**'] }),
      human({ id: 'check', title: '', needs: ['code'], ask: '确认', form: 'approve' }),
    ] })])
    let state = await createEngine(f.deps).start({ requirementId: f.requirementId, workflow: def })
    expect(state.expansions[0]?.nodes?.find((node) => node.id === 'plan/b/code')?.needs).toEqual(['plan/a/check'])
    expect(state.expansions[0]?.nodes?.find((node) => node.id === 'plan/c/code')?.needs).toEqual([])
    const first = (await f.stores.attention.list({ pending: true })).find((item) => item.nodeId === 'plan/a/check')!
    await f.stores.attention.answer(first.requestId, { decision: 'approve', by })
    state = await createEngine(f.deps).resume(state.runId, def)
    expect(state.nodes['plan/b/code']?.status).toBe('succeeded')
    expect(f.events.some((event) => event.type === 'log' && JSON.stringify(event.data).includes('写权限相交'))).toBe(true)
  })
  it('快照包括 workflow 元数据、节点目标/标准以及 review 早停和裁决者', () => {
    const snapshot = snapshotWorkflow({ ...workflow([
      agent({ id: 'a', title: '', role: 'dev', prompt: '', goal: '目标', owner: 'rd', completion: ['测试必须全部通过'] }),
      { id: 'r', kind: 'review', title: '', target: [], author: { role: 'dev' }, reviewers: [{ role: 'qa' }], maxRounds: 3, onExhausted: 'human', stopAfterNoProgress: 2, arbiter: { role: 'verifier', focus: 'blocker', harness: { harness: 'mock' } } },
    ]), tiers: ['T1'], useWhen: '单个改动面', leadInstructions: '主动推进', dynamicRules: ['建议'], budget: { tokens: 100 } })
    expect(snapshot).toMatchObject({ tiers: ['T1'], useWhen: '单个改动面', leadInstructions: '主动推进', dynamicRules: ['建议'], budget: { tokens: 100 } })
    expect(snapshot.nodes[0]).toMatchObject({ goal: '目标', owner: 'rd', completion: ['测试必须全部通过'] })
    expect(snapshot.nodes[1]?.review).toMatchObject({ stopAfterNoProgress: 2, arbiter: { role: 'verifier', focus: 'blocker', harness: 'mock' } })
  })
})

describe('交付校验', () => {
  it.each(['passed', 'failed', 'missing-evidence', 'no-cases'])('逐条 AC 检查用例、最新结果和证据：%s', async (scenario) => {
    const f = await fixture()
    await f.write('spec/spec.md', 'AC-1: 功能正确', 'spec')
    if (scenario !== 'no-cases') await f.write('cases/TC-1.json', JSON.stringify({ id: 'TC-1', covers: ['AC-1'] }), 'case')
    if (scenario !== 'missing-evidence') await f.write('evidence/TC-1/log.txt', '运行证据', 'evidence')
    await f.write('evidence/summary.json', JSON.stringify({ cases: [{ id: 'TC-1', status: scenario === 'failed' ? 'failed' : 'passed' }] }), 'evidence')
    const state = await createEngine(f.deps).start({ requirementId: f.requirementId, workflow: workflow([gate({ id: 'g', title: '', checks: [{ id: 'ac', kind: 'acceptance' }] })]) })
    expect(state.nodes.g?.status).toBe(scenario === 'passed' ? 'succeeded' : 'failed')
    expect(state.nodes.g?.result).toMatchObject({ checks: [{ details: [{ ac: 'AC-1' }] }] })
  })
  it.each(['dev', 'verifier'])('有复核角色时强制产出角色隔离：%s', async (role) => {
    const f = await fixture(async (req) => {
      if (req.env?.TAKT_NODE === 'a') await writeText(req.env.TAKT_WORKSPACE!, 'cases/TC-1.json', JSON.stringify({ id: 'TC-1', covers: ['AC-1'] }))
      return { ok: true, finalText: '', structured: { pass: true, score: 100, message: '证据完整' } }
    })
    await f.write('spec/spec.md', 'AC-1: 功能正确', 'spec')
    await f.write('evidence/TC-1/log.txt', '证据', 'evidence')
    await f.write('evidence/summary.json', JSON.stringify({ cases: [{ id: 'TC-1', status: 'passed' }] }), 'evidence')
    const state = await createEngine(f.deps).start({ requirementId: f.requirementId, workflow: workflow([
      agent({ id: 'a', title: '', role: 'dev', prompt: '', outputs: [{ path: 'cases/*.json', kind: 'case' }] }),
      gate({ id: 'g', title: '', needs: ['a'], checks: [{ id: 'ac', kind: 'acceptance', role }] }),
    ]) })
    expect(state.nodes.g?.status).toBe(role === 'dev' ? 'failed' : 'succeeded')
    expect(f.calls).toHaveLength(role === 'dev' ? 1 : 2)
  })
})
