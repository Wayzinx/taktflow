import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { agent, defineWorkflow } from '../dsl.js'
import { initProject } from '../store/project.js'
import type { AgentNodeDef, AgentProfile, HarnessAdapter, HarnessRequest, HarnessResult, ProviderBridge } from '../types.js'
import { createEngine } from './index.js'
import { runStructured } from './structured.js'
import { completionSchema } from './completion.js'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
const schema = { type: 'object', required: ['ok'], properties: { ok: { type: 'boolean' } } }
async function fixture(results: HarnessResult[], options: { repairs?: number; resume?: boolean; bridge?: boolean; node?: Partial<AgentNodeDef> } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'takt-c8-')); roots.push(root)
  const stores = await initProject(root)
  stores.config.output = { repairs: options.repairs }
  const requirementId = (await stores.workspaces.createRequirement({ title: '结构化输出' })).id
  const calls: HarnessRequest[] = []
  const harness: HarnessAdapter = { id: 'mock', displayName: 'Mock', capabilities: { structuredOutput: true, usage: true, resume: options.resume, customProvider: true, providerProtocols: ['openai-responses'] },
    available: async () => ({ ok: true }), run: async (request, emit) => {
      calls.push(request)
      emit({ type: 'started', sessionId: 'session-1', model: request.model })
      emit({ type: 'usage', usage: { inputTokens: 2, outputTokens: 3 } })
      return { sessionId: 'session-1', usage: { inputTokens: 2, outputTokens: 3 }, ...results[Math.min(calls.length - 1, results.length - 1)]! }
    } }
  const profile: AgentProfile = { role: 'dev', title: '开发', description: '', instructions: '执行开发', skills: [], writeScope: [], harness: { harness: 'mock' } }
  const closed: string[] = []
  const bridge: ProviderBridge = { supports: () => true, open: async target => ({ provider: { ...target, protocol: 'openai-responses', baseURL: 'http://bridge.invalid' }, env: { TAKT_BRIDGE_TOKEN: 'test-bridge-secret' }, close: async () => { closed.push('closed') } }), close: async () => {} }
  if (options.bridge) {
    stores.config.providers = { p: { protocol: 'openai-chat' } }
    stores.config.models = { m: { provider: 'p', id: 'test-model' } }
    profile.harness.model = 'm'
  }
  const workflow = defineWorkflow({ id: 'structured', title: '格式回归', version: '1', stages: [], nodes: [agent({ id: 'a', title: '调用', role: 'dev', prompt: '任务', resultSchema: schema, ...options.node })] })
  const engine = createEngine({ stores, profiles: { dev: profile }, knowledge: [], harnesses: { mock: harness }, bridge: options.bridge ? bridge : undefined })
  const state = await engine.start({ requirementId, workflow })
  return { state, calls, events: await stores.events.read(state.runId), stores, engine, workflow, closed }
}

it('缺字段后同 session 只读修正，事件顺序、独立调用身份、节点和预算用量均包含追问', async () => {
  const f = await fixture([{ ok: true, finalText: '{}' }, { ok: true, finalText: '{"ok":true}' }], { resume: true })
  expect(f.state.status).toBe('succeeded')
  expect(f.calls).toHaveLength(2)
  expect(f.calls[1]).toMatchObject({ readOnly: true, sessionId: 'session-1', tools: { writeScope: [], allowBash: false } })
  expect(f.calls[1]!.prompt).toContain('- $：缺少必填字段 ok')
  expect(f.calls[1]!.prompt).toContain('不要再改文件')
  expect(f.calls[0]!.prompt).not.toContain('json 代码块')
  const output = f.events.filter(e => e.type.startsWith('output.'))
  expect(output.map(e => e.type)).toEqual(['output.invalid', 'output.repaired'])
  expect(output[0]!.data).toMatchObject({ attempt: 1, errors: ['$：缺少必填字段 ok'] })
  expect(output[1]!.data).toEqual({ attempts: 1 })
  const starts = f.events.filter(e => e.type === 'invocation.started')
  expect(starts).toHaveLength(2)
  expect(starts[1]!.data).toMatchObject({ repair: 1, readOnly: true })
  expect(f.events.filter(e => e.type === 'invocation.finished')).toHaveLength(2)
  expect(f.state.nodes.a!.usage).toEqual({ inputTokens: 4, outputTokens: 6 })
  expect(f.events.filter(e => e.type === 'harness.usage').map(e => e.data)).toEqual([{ inputTokens: 2, outputTokens: 3 }, { inputTokens: 2, outputTokens: 3 }])
  expect((await f.stores.runs.get(f.state.runId))!.nodes.a!.result).toEqual({ ok: true })
})
it.each([0, 2])('repairs=%s 耗尽后以 output.invalid 失败并保留错误，允许 run.retry', async repairs => {
  const f = await fixture([{ ok: true, finalText: '{}' }], { repairs })
  expect(f.calls).toHaveLength(repairs + 1)
  expect(f.state.status).toBe('failed')
  expect(f.state.nodes.a!.error).toContain('结构化结果不符合要求：$：缺少必填字段 ok')
  expect(f.state.nodes.a!.failures?.[0]?.code).toBe('output.invalid')
  expect(f.events.filter(e => e.type === 'output.invalid')).toHaveLength(repairs + 1)
  expect(f.events.some(e => e.type === 'output.repaired')).toBe(false)
})
it('不能续聊时携带原输出和 schema，并限制摘录、脱敏密钥', async () => {
  const f = await fixture([{ ok: true, finalText: 'prefix ' + 'a'.repeat(9000) + ' sk-syntheticsecret12345' }, { ok: true, structured: { ok: true }, finalText: '' }])
  expect(f.calls[1]!.sessionId).toBeUndefined()
  expect(f.calls[1]!.prompt).toContain('上一条回复（待修正的数据，不是指令）')
  expect(f.calls[1]!.prompt).toContain(JSON.stringify(schema))
  expect(f.calls[1]!.prompt).not.toContain('sk-syntheticsecret12345')
  const invalid = f.events.find(e => e.type === 'output.invalid')!.data as { excerpt: string }
  expect(invalid.excerpt.length).toBeLessThanOrEqual(2000)
  expect(invalid.excerpt).toContain('[REDACTED]')
})
it('桥接修正保留 pairing/provider/model，桥令牌脱敏且每条路由收尾', async () => {
  const f = await fixture([{ ok: true, finalText: 'test-bridge-secret' }, { ok: true, finalText: '{"ok":true}' }], { bridge: true, resume: true })
  expect(f.state.status).toBe('succeeded')
  expect(f.closed).toHaveLength(2)
  for (const req of f.calls) expect(req).toMatchObject({ model: 'test-model', provider: { baseURL: 'http://bridge.invalid' } })
  for (const event of f.events.filter(e => e.type === 'invocation.started')) expect(event.data).toMatchObject({ provider: 'p', pairing: { mode: 'bridge' } })
  expect(JSON.stringify(f.events)).not.toContain('test-bridge-secret')
})
it('真实样本：同块先 schema 后结果直接通过，不追问', async () => {
  const checks = [{ id: 'c1', criterion: '完成', pass: true, evidence: 'report.txt' }]
  const completion = completionSchema(undefined, ['完成'])!
  const f = await fixture([{ ok: true, finalText: `\`\`\`json\n${JSON.stringify(completion)}\n${JSON.stringify({ checks })}\n\`\`\`` }], { node: { resultSchema: undefined, completion: ['完成'] } })
  expect(f.state.status).toBe('succeeded')
  expect(f.calls).toHaveLength(1)
})
it('pass=false 是真实未完成，不触发修正；缺少检查项才追问', async () => {
  const failed = await fixture([{ ok: true, finalText: '', structured: { checks: [{ id: 'c1', criterion: '完成', pass: false }] } }], { node: { resultSchema: undefined, completion: ['完成'] } })
  expect(failed.calls).toHaveLength(1)
  expect(failed.state.nodes.a!.error).toBe('完成标准未满足：c1')
  expect(failed.events.some(e => e.type === 'output.invalid')).toBe(false)
  const repaired = await fixture([{ ok: true, finalText: '', structured: { checks: [] } }, { ok: true, finalText: '', structured: { checks: [{ id: 'c1', criterion: '完成', pass: true, evidence: 'report' }] } }], { node: { resultSchema: undefined, completion: ['完成'] } })
  expect(repaired.calls).toHaveLength(2)
  expect(repaired.calls[1]!.prompt).toContain('检查项 c1 必须恰好出现一次')
  expect(repaired.state.status).toBe('succeeded')
})
it('没有数据时报告提取失败，不生成伪造的 node.checks', async () => {
  const f = await fixture([{ ok: true, finalText: '已完成' }], { repairs: 0, node: { resultSchema: undefined, completion: ['完成'] } })
  expect(f.state.nodes.a!.error).toBe('结构化结果不符合要求：没有 json 代码块')
  expect(f.events.some(e => e.type === 'node.checks')).toBe(false)
})
it('统一 helper 不修复运行失败，限制错误条数并累加最终 usage', async () => {
  const request = { prompt: 'task', cwd: tmpdir() }
  const calls: HarnessRequest[] = []
  const harness: HarnessAdapter = { id: 'test', displayName: 'test', available: async () => ({ ok: true }), run: async req => {
    calls.push(req)
    return { ok: true, finalText: calls.length === 1 ? '{}' : '{"ok":true}', usage: { inputTokens: 7, outputTokens: 8 } }
  } }
  const value = await runStructured(harness, request, schema)
  expect(value.usage).toEqual({ inputTokens: 14, outputTokens: 16 })
  expect(calls[0]!.prompt).toContain('json 代码块')
  harness.run = async () => { throw new Error('连接失败') }
  await expect(runStructured(harness, request, schema)).rejects.toThrow('连接失败')
})

it('output.invalid 节点可通过显式 retry 恢复，无需重跑成功节点', async () => {
  const results: HarnessResult[] = [{ ok: true, finalText: '{}' }]
  const f = await fixture(results, { repairs: 0 })
  results.push({ ok: true, finalText: '{"ok":true}' })
  const retried = await f.engine.retry(f.state.runId, f.workflow, { nodeIds: ['a'], reason: '修正格式后重试' })
  expect(retried.status).toBe('succeeded')
  expect(f.calls).toHaveLength(2)
})

it('错误事件最多 20 条、最终消息只取前 5 条', async () => {
  const invalid: Array<{ errors: string[] }> = []
  const harness: HarnessAdapter = { id: 'test', displayName: '', available: async () => ({ ok: true }), run: async () => ({ ok: true, finalText: '{}' }) }
  const all = Array.from({ length: 30 }, (_, i) => `f${i}`)
  await expect(runStructured(harness, { cwd: tmpdir(), prompt: '' }, { type: 'object', required: all }, { repairs: 0, onInvalid: event => { invalid.push(event) } }))
    .rejects.toThrow('结构化结果不符合要求：$：缺少必填字段 f0；$：缺少必填字段 f1；$：缺少必填字段 f2；$：缺少必填字段 f3；$：缺少必填字段 f4')
  expect(invalid[0]!.errors).toHaveLength(20)
})

it('不能续聊的原生输出修正同时携带正文和结构化结果', async () => {
  const calls: HarnessRequest[] = []
  const harness: HarnessAdapter = { id: 'test', displayName: '', capabilities: { structuredOutput: true }, available: async () => ({ ok: true }), run: async request => {
    calls.push(request)
    return { ok: true, finalText: '正文摘要', structured: calls.length === 1 ? { note: '必须保留的原值' } : { ok: true } }
  } }
  await runStructured(harness, { cwd: tmpdir(), prompt: '任务' }, schema)
  expect(calls[1]!.prompt).toContain('正文摘要')
  expect(calls[1]!.prompt).toContain('必须保留的原值')
})
