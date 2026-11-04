import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { agent, gate, human, loop, script } from '../dsl.js'
import { initProject } from '../store/project.js'
import type { AgentProfile, HarnessAdapter, NodeDef, WorkflowDefinition } from '../types.js'
import { createEngine } from './index.js'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'takt-engine-review-'))
  roots.push(root)
  const stores = await initProject(root)
  const requirement = await stores.workspaces.createRequirement({ title: '引擎审查' })
  return { stores, requirementId: requirement.id }
}

const workflow = (nodes: NodeDef[]): WorkflowDefinition => ({
  id: 'review', title: '审查', version: '1', stages: [], nodes,
})
const profile: AgentProfile = {
  role: 'dev', title: '开发', description: '', instructions: '完成任务',
  harness: { harness: 'mock' }, skills: [], writeScope: ['**'],
}

it('脚本覆盖已登记产物后立即读取，得到本轮磁盘内容而不是上轮对象', async () => {
  const { stores, requirementId } = await fixture()
  await stores.workspaces.writeArtifact({
    ref: { workspace: requirementId, path: 'summary.json' },
    content: '{"failures":["old"]}', kind: 'evidence', author: { type: 'system', id: 'fixture' },
  })
  const engine = createEngine({ stores, profiles: {}, harnesses: {}, knowledge: [] })
  const state = await engine.start({ requirementId, workflow: workflow([
    script({ id: 'run', title: '重新执行', outputs: [{ path: 'summary.json', kind: 'evidence' }], run: async (ctx) => {
      await writeFile(join(ctx.workspaceDir, 'summary.json'), '{"failures":[]}')
      return { data: JSON.parse((await ctx.readArtifact('summary.json'))!) as unknown }
    } }),
  ]) })
  expect(state.status).toBe('succeeded')
  expect(state.nodes.run?.result).toEqual({ failures: [] })
  expect(state.nodes.run?.outputs[0]?.version).toBe(2)
})

it('三轮 loop 内人工请求分别批准，上一轮回答不能自动批准下一轮', async () => {
  const { stores, requirementId } = await fixture()
  let executions = 0
  const def = workflow([loop({
    id: 'cycle', title: '三轮确认', maxIterations: 3,
    until: (ctx) => ctx.iteration === 3,
    body: [
      script({ id: 'work', title: '执行', run: async () => { executions++ } }),
      human({ id: 'confirm', title: '确认', needs: ['work'], ask: '批准本轮？', form: 'approve' }),
    ],
  })])
  const deps = { stores, profiles: {}, harnesses: {}, knowledge: [] }
  const first = await createEngine(deps).start({ requirementId, workflow: def })
  expect(first.status).toBe('waiting_human')
  const requestId = `${first.runId}:cycle/confirm`
  const [request1] = await stores.attention.list({ pending: true })
  expect(request1?.requestId).toBe(requestId)
  await stores.attention.answer(requestId, { decision: 'approve', by: { type: 'human', id: 'reviewer-1' } })
  const second = await createEngine(deps).resume(first.runId, def)
  expect(second.status).toBe('waiting_human')
  expect(executions).toBe(2)
  const pending2 = await stores.attention.list({ pending: true })
  expect(pending2.map((item) => item.requestId)).toEqual([`${requestId}#2`])
  await stores.attention.answer(`${requestId}#2`, { decision: 'approve', by: { type: 'human', id: 'reviewer-2' } })
  const third = await createEngine(deps).resume(first.runId, def)
  expect(third.status).toBe('waiting_human')
  expect(executions).toBe(3)
  const pending3 = await stores.attention.list({ pending: true })
  expect(pending3.map((item) => item.requestId)).toEqual([`${requestId}#3`])
  // 旧轮次的答复记录保留，本轮只是另一个未回答的独立 pending
  expect((await stores.attention.list({ requirementId })).map((item) => [item.requestId, item.answeredBy, item.answeredAt !== undefined])).toEqual([
    [requestId, { type: 'human', id: 'reviewer-1' }, true],
    [`${requestId}#2`, { type: 'human', id: 'reviewer-2' }, true],
    [`${requestId}#3`, undefined, false],
  ])
  await stores.attention.answer(`${requestId}#3`, { decision: 'approve', by: { type: 'human', id: 'reviewer-3' } })
  const completed = await createEngine(deps).resume(first.runId, def)
  expect(completed.status).toBe('succeeded')
  expect(executions).toBe(3)
  expect(await stores.events.verify(first.runId)).toEqual({ ok: true })
})

it('retry 注入失败原因，resultSchema 校验最后一个 JSON 代码块', async () => {
  const { stores, requirementId } = await fixture()
  const prompts: string[] = []
  const harness: HarnessAdapter = {
    id: 'mock', displayName: 'mock', available: async () => ({ ok: true }),
    run: async (req) => {
      prompts.push(req.prompt)
      if (prompts.length === 1) return { ok: false, finalText: '', error: '第一次缺少证据' }
      return { ok: true, finalText: '```json\n{"ok":"wrong"}\n```\n最终：\n```json\n{"ok":true}\n```' }
    },
  }
  const state = await createEngine({ stores, profiles: { dev: profile }, harnesses: { mock: harness }, knowledge: [] })
    .start({ requirementId, workflow: workflow([agent({
      id: 'retry', title: '重试', role: 'dev', prompt: '完成验证', retry: { max: 1 },
      resultSchema: { type: 'object', required: ['ok'], properties: { ok: { type: 'boolean', enum: [true] } } },
    })]) })
  expect(state.status).toBe('succeeded')
  expect(prompts).toHaveLength(2)
  expect(prompts[1]).toContain('上一次失败原因：第一次缺少证据')
  expect(prompts[1]?.endsWith('上一次失败原因：第一次缺少证据')).toBe(true)
  expect(state.nodes.retry?.result).toEqual({ ok: true })
})

it('autoApprove 保留 answer 文本和 human actor，抛错门禁仍先记录失败检查', async () => {
  const { stores, requirementId } = await fixture()
  const state = await createEngine({ stores, profiles: {}, harnesses: {}, knowledge: [] }, { autoApprove: true })
    .start({ requirementId, workflow: workflow([
      human({ id: 'answer', title: '补充', ask: '补充说明', form: 'answer' }),
      gate({ id: 'gate', title: '门禁', needs: ['answer'], onFail: 'human', checks: [
        { id: 'broken', kind: 'function', fn: async () => { throw new Error('检查器故障') } },
      ] }),
    ]) })
  expect(state.status).toBe('succeeded')
  expect(state.nodes.answer?.result).toMatchObject({ answer: '（自动通过）' })
  const events = await stores.events.read(state.runId)
  expect(events.filter((event) => event.type === 'human.requested')).toHaveLength(2)
  const answered = events.filter((event) => event.type === 'human.answered')
  expect(answered).toHaveLength(2)
  expect(answered.every((event) => event.actor.type === 'human' && event.actor.id === 'auto-approve')).toBe(true)
  expect(events.find((event) => event.type === 'gate.result')?.data).toMatchObject({ pass: false })
})

it('两个容器共享叶子并发额度，容器本身不占用执行槽位', async () => {
  const { stores, requirementId } = await fixture()
  let active = 0
  let peak = 0
  let completed = 0
  const body = (): NodeDef[] => Array.from({ length: 3 }, (_, index) => script({
    id: `job-${index}`, title: '任务', run: async () => {
      active++
      peak = Math.max(peak, active)
      await new Promise((resolve) => setTimeout(resolve, 15))
      active--
      completed++
    },
  }))
  const state = await createEngine({ stores, profiles: {}, harnesses: {}, knowledge: [] }, { concurrency: 2 })
    .start({ requirementId, workflow: workflow([
      loop({ id: 'a', title: 'A', body: body(), until: () => true, maxIterations: 1 }),
      loop({ id: 'b', title: 'B', body: body(), until: () => true, maxIterations: 1 }),
    ]) })
  expect(state.status).toBe('succeeded')
  expect(completed).toBe(6)
  expect(peak).toBeLessThanOrEqual(2)
  expect(peak).toBe(2)
})

it('嵌套 loop 的内层轮次独立初始化，外层下一轮完整重跑子 DAG', async () => {
  const { stores, requirementId } = await fixture()
  const iterations: number[] = []
  const state = await createEngine({ stores, profiles: {}, harnesses: {}, knowledge: [] }, { concurrency: 1 })
    .start({ requirementId, workflow: workflow([loop({
      id: 'outer', title: '外层', maxIterations: 2, until: (ctx) => ctx.iteration === 2,
      body: [loop({ id: 'inner', title: '内层', maxIterations: 1, until: () => true, body: [
        script({ id: 'work', title: '执行', run: async (ctx) => { iterations.push(ctx.iteration!) } }),
      ] })],
    })]) })
  expect(state.status).toBe('succeeded')
  expect(iterations).toEqual([1, 1])
})

it('harness 按 available 和可重试错误降级，知识与实时事件落盘且审计链有效', async () => {
  const { stores, requirementId } = await fixture()
  const calls: string[] = []
  const unavailable: HarnessAdapter = {
    id: 'unavailable', displayName: 'unavailable', available: async () => ({ ok: false, reason: '未安装' }),
    run: async () => { throw new Error('不应调用不可用适配器') },
  }
  const limited: HarnessAdapter = {
    id: 'limited', displayName: 'limited', available: async () => ({ ok: true }),
    run: async () => { calls.push('limited'); return { ok: false, finalText: '', error: '429 rate limited' } },
  }
  const mock: HarnessAdapter = {
    id: 'mock', displayName: 'mock', capabilities: { usage: true }, available: async () => ({ ok: true }),
    run: async (req, onEvent) => {
      calls.push('mock')
      expect(req.prompt).toContain('业务证据摘要')
      expect(req.env).toMatchObject({ TAKT_ROLE: 'dev', TAKT_NODE: 'fallback', TAKT_WORKSPACE: stores.workspaces.dir(requirementId) })
      expect(req.env?.TAKT_TRANSCRIPT).toContain(`/runs/${req.env?.TAKT_RUN_ID}/transcripts/fallback.jsonl`)
      onEvent({ type: 'started', sessionId: 'session-1' })
      onEvent({ type: 'message', role: 'assistant', text: '正在执行' })
      onEvent({ type: 'tool_call', tool: 'read', input: 'spec.md', output: '证据', ok: true })
      onEvent({ type: 'usage', usage: { inputTokens: 10, outputTokens: 20 } })
      onEvent({ type: 'compacted', record: { at: '2026-11-04T00:00:00Z', trigger: 'auto', beforeTokens: 100, afterTokens: 50, summary: '摘要', dropped: [] } })
      return { ok: true, finalText: '完成', usage: { inputTokens: 10, outputTokens: 20 } }
    },
  }
  const state = await createEngine({
    stores, profiles: { dev: profile }, harnesses: { unavailable, limited, mock }, knowledge: [
      { id: 'business', kind: 'wiki', intents: ['business'], describe: () => '', query: async () => [{ sourceId: 'business', title: '规则', ref: 'rule-1', snippet: '业务证据摘要' }] },
      { id: 'unused', kind: 'grep', intents: ['symbol'], describe: () => '', query: async () => { throw new Error('不应查询不匹配 intent 的源') } },
    ],
  }).start({ requirementId, workflow: workflow([agent({
    id: 'fallback', title: '降级', role: 'dev', prompt: '完成验证',
    harness: { harness: 'unavailable', fallback: [{ harness: 'limited' }, { harness: 'mock' }] },
    knowledge: [{ text: '查询规则', intent: 'business' }],
  })]) })
  expect(state.status).toBe('succeeded')
  expect(calls).toEqual(['limited', 'mock'])
  expect(state.nodes.fallback?.usage).toEqual({ inputTokens: 10, outputTokens: 20 })
  const context = await stores.runs.getContext(state.runId, 'fallback')
  expect(context.snapshots).toHaveLength(1)
  expect(context.snapshots[0]?.budgetTokens).toBe(200000)
  expect(context.compactions).toHaveLength(1)
  const events = await stores.events.read(state.runId)
  expect(events.filter((e) => e.type === 'log' && (e.data as { message: string }).message.includes('切换 harness'))).toHaveLength(2)
  expect(events.map((e) => e.type)).toEqual(expect.arrayContaining(['harness.started', 'harness.message', 'harness.tool_call', 'harness.usage', 'context.compacted', 'knowledge.query']))
  expect(await stores.events.verify(state.runId)).toEqual({ ok: true })
})

it.each(['missing', 'invalid-json'])('必需产物不满足契约时失败：%s', async (mode) => {
  const { stores, requirementId } = await fixture()
  const state = await createEngine({ stores, profiles: {}, harnesses: {}, knowledge: [] }).start({ requirementId, workflow: workflow([
    script({ id: 'output', title: '产物', outputs: [{ path: 'result.json', kind: 'report', schema: {
      type: 'object', required: ['items'], properties: { items: { type: 'array', items: { type: 'string', enum: ['valid'] } } },
    } }], run: async (ctx) => {
      if (mode === 'invalid-json') await writeFile(join(ctx.workspaceDir, 'result.json'), '{"items":["wrong"]}')
    } }),
    script({ id: 'next', title: '下游', needs: ['output'], run: async () => { throw new Error('不应执行') } }),
  ]) })
  expect(state.status).toBe('failed')
  expect(state.nodes.output?.status).toBe('failed')
  expect(state.nodes.next?.status).toBe('pending')
})

it('产物收集期间输入被标记 stale，晚到的节点完成不能覆盖 stale', async () => {
  const { stores, requirementId } = await fixture()
  await stores.workspaces.writeArtifact({ ref: { workspace: requirementId, path: 'input.md' }, content: '原文', kind: 'input', author: { type: 'system', id: 'fixture' } })
  let notify: (runId: string) => void = () => undefined
  const entered = new Promise<string>((resolve) => { notify = resolve })
  let release: () => void = () => undefined
  const barrier = new Promise<void>((resolve) => { release = resolve })
  const write = stores.workspaces.writeArtifact.bind(stores.workspaces)
  stores.workspaces.writeArtifact = async (input) => {
    if (input.ref.path === 'output.md' && input.producedBy) {
      notify(input.producedBy.runId)
      await barrier
    }
    return write(input)
  }
  const engine = createEngine({ stores, profiles: {}, harnesses: {}, knowledge: [] })
  const pending = engine.start({ requirementId, workflow: workflow([
    script({ id: 'source', title: '读取输入', inputs: [{ path: 'input.md' }], outputs: [{ path: 'output.md', kind: 'report' }],
      run: async (ctx) => { await writeFile(join(ctx.workspaceDir, 'output.md'), '输出') } }),
    script({ id: 'after', title: '后续', needs: ['source'], run: async () => { throw new Error('不应执行') } }),
  ]) })
  const runId = await entered
  try {
    expect(new Set(await engine.markStale(runId, { workspace: requirementId, path: 'input.md' }))).toEqual(new Set(['source', 'after']))
  } finally { release() }
  const state = await pending
  expect(state.nodes.source?.status).toBe('stale')
  expect(state.nodes.after?.status).toBe('stale')
  expect((await stores.runs.get(runId))?.nodes.source?.status).toBe('stale')
})

it('同一引擎并发运行两个 workflow，合法写入不会互相触发守卫', async () => {
  const { stores, requirementId } = await fixture()
  let entered = 0
  let release: () => void = () => undefined
  const barrier = new Promise<void>((resolve) => { release = resolve })
  const mock: HarnessAdapter = {
    id: 'mock', displayName: 'mock', available: async () => ({ ok: true }),
    run: async (req) => {
      if (++entered === 2) release()
      await barrier
      await writeFile(join(req.cwd, `${req.env!.TAKT_NODE}.txt`), '合法写入')
      await new Promise((resolve) => setTimeout(resolve, req.env!.TAKT_NODE === 'a' ? 20 : 60))
      return { ok: true, finalText: '完成' }
    },
  }
  const engine = createEngine({ stores, profiles: { dev: { ...profile, writeScope: ['a.txt', 'b.txt'] } }, harnesses: { mock }, knowledge: [] })
  const states = await Promise.all(['a', 'b'].map((id) => engine.start({ requirementId, workflow: workflow([
    agent({ id, title: id, role: 'dev', prompt: '写文件', writeScope: [`${id}.txt`] }),
  ]) })))
  expect(states.map((state) => state.status)).toEqual(['succeeded', 'succeeded'])
})

it('git 守卫标记越界但不覆盖暂存、人工或新文件', async () => {
  const { stores, requirementId } = await fixture()
  const root = stores.projectDir
  execFileSync('git', ['init', '--quiet'], { cwd: root })
  await writeFile(join(root, 'tracked.txt'), '原始内容')
  execFileSync('git', ['add', '--', 'tracked.txt'], { cwd: root })
  const mock: HarnessAdapter = {
    id: 'mock', displayName: 'mock', available: async () => ({ ok: true }),
    run: async () => {
      await writeFile(join(root, 'tracked.txt'), '越界修改')
      await writeFile(join(root, 'new.txt'), '越界新增')
      return { ok: true, finalText: '完成' }
    },
  }
  const state = await createEngine({ stores, profiles: { dev: profile }, harnesses: { mock }, knowledge: [] })
    .start({ requirementId, workflow: workflow([agent({ id: 'guard', title: '守卫', role: 'dev', prompt: '执行', writeScope: [] })]) })
  expect(state.nodes.guard?.status).toBe('blocked')
  expect(await readFile(join(root, 'tracked.txt'), 'utf8')).toBe('越界修改')
  expect(await readFile(join(root, 'new.txt'), 'utf8')).toBe('越界新增')
  const events = await stores.events.read(state.runId, { types: ['guard.violation'] })
  expect(events[0]?.data).toMatchObject({ action: 'flagged', paths: expect.arrayContaining(['tracked.txt', 'new.txt']) })
})
