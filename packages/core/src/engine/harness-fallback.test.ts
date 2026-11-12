import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { agent } from '../dsl.js'
import { initProject } from '../store/project.js'
import type { AgentProfile, EventPayloads, HarnessAdapter, HarnessResult, NodeDef, WorkflowDefinition } from '../types.js'
import { harnessEnvFailure } from './harness-failure.js'
import { createEngine } from './index.js'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))) })
const expired = 'Claude Code：Failed to authenticate: OAuth session expired and could not be refreshed\nProcess exited with code 1'
const workflow = (nodes: NodeDef[]): WorkflowDefinition => ({ id: 'fallback', title: '降级', version: '1', stages: [], nodes })
async function fixture(first: () => Promise<HarnessResult>, second: () => Promise<HarnessResult> = async () => ({ ok: true, finalText: '接手完成' })) {
  const root = await mkdtemp(join(tmpdir(), 'takt-harness-fallback-')); roots.push(root)
  const stores = await initProject(root)
  const requirementId = (await stores.workspaces.createRequirement({ title: '降级' })).id
  const calls: string[] = []
  const adapter = (id: string, run: () => Promise<HarnessResult>): HarnessAdapter => ({ id, displayName: id, available: async () => ({ ok: true }),
    run: async () => { calls.push(id); return run() } })
  const profile: AgentProfile = { role: 'pm', title: '产品', description: '', instructions: '', skills: [], writeScope: ['**'],
    harness: { harness: 'claude-code', fallback: [{ harness: 'codex' }] } }
  const deps = { stores, profiles: { pm: profile }, harnesses: { 'claude-code': adapter('claude-code', first), codex: adapter('codex', second) }, knowledge: [] }
  return { stores, requirementId, deps, calls }
}

it('调用期认证失败按角色 fallback 链切到下一个 harness，并在事件里写明原因', async () => {
  const f = await fixture(async () => ({ ok: false, finalText: '', error: expired, exitCode: 1 }))
  const state = await createEngine(f.deps).start({ requirementId: f.requirementId, workflow: workflow([agent({ id: 'spec', title: '需求说明', role: 'pm', prompt: '写 spec' })]) })
  expect(state.status).toBe('succeeded')
  expect(f.calls).toEqual(['claude-code', 'codex'])
  const logs = (await f.stores.events.read(state.runId, { types: ['log'] })).map((event) => (event.data as EventPayloads['log']).message)
  expect(logs).toContainEqual(expect.stringMatching(/^切换 harness → codex：claude-code 登录或认证失败：.*OAuth session expired/))
  const starts = (await f.stores.events.read(state.runId, { types: ['invocation.started'] })).map((event) => event.data as EventPayloads['invocation.started'])
  expect(starts.map((start) => [start.harness, start.fallbackIndex])).toEqual([['claude-code', 0], ['codex', 1]])
  const ends = (await f.stores.events.read(state.runId, { types: ['invocation.finished'] })).map((event) => (event.data as EventPayloads['invocation.finished']).outcome)
  expect(ends).toEqual(['error', 'ok'])
})

it('进程启动失败（adapter 抛错）同样切换', async () => {
  const f = await fixture(async () => { throw new Error('Process error: spawn claude ENOENT') })
  const state = await createEngine(f.deps).start({ requirementId: f.requirementId, workflow: workflow([agent({ id: 'spec', title: '', role: 'pm', prompt: '' })]) })
  expect(state.status).toBe('succeeded')
  expect(f.calls).toEqual(['claude-code', 'codex'])
})

it('角色 fallback 链继续跳过不可用候选，第三个 harness 接手', async () => {
  const f = await fixture(async () => ({ ok: false, finalText: '', error: expired }))
  f.deps.profiles.pm!.harness.fallback!.push({ harness: 'third' })
  f.deps.harnesses.codex!.available = async () => ({ ok: false, reason: 'codex 未安装' })
  Object.assign(f.deps.harnesses, { third: { id: 'third', displayName: '第三候选', available: async () => ({ ok: true }),
    run: async () => { f.calls.push('third'); return { ok: true, finalText: '完成' } } } })
  const state = await createEngine(f.deps).start({ requirementId: f.requirementId, workflow: workflow([agent({ id: 'spec', title: '', role: 'pm', prompt: '' })]) })
  expect(state.status).toBe('succeeded')
  expect(f.calls).toEqual(['claude-code', 'third'])
  const logs = (await f.stores.events.read(state.runId, { types: ['log'] })).map((event) => (event.data as EventPayloads['log']).message)
  expect(logs).toContain('切换 harness → third：codex 未安装')
})

it('事件持久化失败即使含认证字样也不能当成 harness 环境失败切换', async () => {
  const f = await fixture(async () => ({ ok: true, finalText: '完成' }))
  const run = f.deps.harnesses['claude-code']!.run
  f.deps.harnesses['claude-code']!.run = async (request, onEvent) => {
    onEvent({ type: 'message', role: 'assistant', text: '完成' })
    return run(request, onEvent)
  }
  const append = f.stores.events.append.bind(f.stores.events)
  vi.spyOn(f.stores.events, 'append').mockImplementation(async (runId, event) => {
    if (event.type === 'harness.message' && event.data.role === 'assistant') throw new Error('OAuth 审计消息写入失败')
    return append(runId, event)
  })
  const state = await createEngine(f.deps).start({ requirementId: f.requirementId, workflow: workflow([agent({ id: 'spec', title: '', role: 'pm', prompt: '' })]) })
  expect(state.status).toBe('failed')
  expect(f.calls).toEqual(['claude-code'])
})

it('fallback 链的调用用量累加到节点，不丢掉失败调用的用量', async () => {
  const f = await fixture(async () => ({ ok: false, finalText: '', error: expired, usage: { inputTokens: 10, outputTokens: 2 } }),
    async () => ({ ok: true, finalText: '完成', usage: { inputTokens: 20, outputTokens: 3 } }))
  for (const harness of Object.values(f.deps.harnesses)) harness.capabilities = { usage: true }
  const state = await createEngine(f.deps).start({ requirementId: f.requirementId, workflow: workflow([agent({ id: 'spec', title: '', role: 'pm', prompt: '' })]) })
  expect(state.nodes.spec!.usage).toMatchObject({ inputTokens: 30, outputTokens: 5 })
})

it('业务失败与完成标准不满足不换 harness', async () => {
  const business = await fixture(async () => ({ ok: false, finalText: '', error: '用例 TC-1 未通过：expected OAuth session expired, got success\nProcess exited with code 1', exitCode: 1 }))
  const failed = await createEngine(business.deps).start({ requirementId: business.requirementId, workflow: workflow([agent({ id: 'spec', title: '', role: 'pm', prompt: '' })]) })
  expect(failed.nodes.spec).toMatchObject({ status: 'failed', error: expect.stringContaining('TC-1 未通过') })
  expect(business.calls).toEqual(['claude-code'])

  const unmet = await fixture(async () => ({ ok: true, finalText: '', structured: { checks: [{ id: 'c1', criterion: '有证据', pass: false }] } }))
  const state = await createEngine(unmet.deps).start({ requirementId: unmet.requirementId, workflow: workflow([agent({ id: 'spec', title: '', role: 'pm', prompt: '', completion: ['有证据'] })]) })
  expect(state.nodes.spec).toMatchObject({ status: 'failed', error: expect.stringContaining('完成标准未满足') })
  expect(unmet.calls).toEqual(['claude-code'])
})

it('整条链都是环境问题时报出每一环的原因和处理建议', async () => {
  const f = await fixture(async () => ({ ok: false, finalText: '', error: expired }), async () => ({ ok: false, finalText: '', error: 'HTTP 429 rate_limit' }))
  const state = await createEngine(f.deps).start({ requirementId: f.requirementId, workflow: workflow([agent({ id: 'spec', title: '', role: 'pm', prompt: '' })]) })
  expect(state.nodes.spec!.status).toBe('failed')
  expect(state.nodes.spec!.error).toMatch(/^claude-code 登录或认证失败：.*；codex 额度用完或被限流：HTTP 429 rate_limit\n处理建议：/s)
  expect(f.calls).toEqual(['claude-code', 'codex'])
})

it.each([
  [expired, '登录或认证失败'], ['HTTP 401 ACCOUNT_SIGN_IN_REQUIRED Sign in', '登录或认证失败'], ['Claude Code provider missing API key environment variable: KEY', '登录或认证失败'],
  ['HTTP 429 rate_limit', '额度用完或被限流'], ['503 unavailable', '服务暂不可用'], ['Process error: spawn codex EACCES', '进程启动失败'], ['Process timeout after 1000ms', '调用超时'],
  ['用例 TC-1 未通过\nProcess exited with code 1', undefined], ['assign in order failed', undefined], ['写权限越界：src/a.ts', undefined],
])('环境类失败识别：%s', (message, kind) => {
  expect(harnessEnvFailure(message)).toBe(kind)
})
