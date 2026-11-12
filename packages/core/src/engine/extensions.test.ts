import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { createNativeHarness } from '../../../harness/src/native/index.js'
import { agent, loop, planner, human, script } from '../dsl.js'
import { initProject, openProject } from '../store/project.js'
import { estimateTokens } from '../util/tokens.js'
import type { AgentProfile, HarnessAdapter, HarnessRequest, ModelProvider, NodeDef, WorkflowDefinition } from '../types.js'
import { createEngine } from './index.js'
import type { HarnessRequest } from '../types.js'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))) })
const workflow = (nodes: NodeDef[]): WorkflowDefinition => ({ id: 'extensions', title: '扩展回归', version: '1', stages: [], nodes })
async function fixture(adapter?: HarnessAdapter) {
  const root = await mkdtemp(join(tmpdir(), 'takt-engine-ext-'))
  roots.push(root)
  const stores = await initProject(root)
  const requirementId = (await stores.workspaces.createRequirement({ title: '扩展' })).id
  const harness: HarnessAdapter = adapter ?? { id: 'mock', displayName: '', available: async () => ({ ok: true }), run: async () => ({ ok: true, finalText: '' }) }
  const profile: AgentProfile = { role: 'dev', title: '开发', description: '', instructions: '完成任务', skills: [], writeScope: ['**'], harness: { harness: harness.id } }
  const deps = { stores, profiles: { dev: profile }, harnesses: { [harness.id]: harness }, knowledge: [] }
  return { root, stores, requirementId, deps, profile, harness }
}

it.each([false, true])('多条 usage 事件按本次调用累计，result.usage 覆盖=%s，node.finished 保留完整总量', async (authoritative) => {
  const { stores, requirementId, deps, harness } = await fixture()
  const chunks = [
    { inputTokens: 10, outputTokens: 5, cachedTokens: 2, costUsd: 0.25 },
    { inputTokens: 20, outputTokens: 7, cachedTokens: 3, costUsd: 0.5 },
  ]
  const total = { inputTokens: 40, outputTokens: 18, cachedTokens: 9, costUsd: 1 }
  const expected = authoritative ? total : { inputTokens: 30, outputTokens: 12, cachedTokens: 5, costUsd: 0.75 }
  harness.capabilities = { usage: true }
  harness.run = async (_req, emit) => {
    for (const usage of chunks) emit({ type: 'usage', usage })
    return { ok: true, finalText: 'done', ...(authoritative ? { usage: total } : {}) }
  }
  const state = await createEngine(deps).start({ requirementId, workflow: workflow([loop({
    id: 'cycle', title: '', maxIterations: 2, until: (ctx) => ctx.iteration === 2,
    body: [agent({ id: 'a', title: '', role: 'dev', prompt: '' })],
  })]) })
  expect(state.status).toBe('succeeded')
  expect(state.nodes['cycle/a']?.usage).toEqual(expected)
  expect((await stores.runs.get(state.runId))?.nodes['cycle/a']?.usage).toEqual(expected)
  const finished = await stores.events.read(state.runId, { nodeId: 'cycle/a', types: ['node.finished'] })
  expect(finished).toHaveLength(2)
  for (const event of finished) expect(event.data).toMatchObject({ status: 'succeeded', usage: expected })
  const streamed = await stores.events.read(state.runId, { nodeId: 'cycle/a', types: ['harness.usage'] })
  const recorded = authoritative ? [...chunks, { inputTokens: 10, outputTokens: 6, cachedTokens: 4, costUsd: 0.25 }] : chunks
  expect(streamed.map((event) => event.data)).toEqual([...recorded, ...recorded])
  expect(await stores.events.verify(state.runId)).toEqual({ ok: true })
})

it('native 真正接收 raw ID、所选 provider、交集和 allowBash，工具先拒绝越界并允许新文件', async () => {
  let round = 0
  const provider: ModelProvider = { id: 'local', protocol: 'openai-chat', available: async () => ({ ok: true }), chat: async (req) => {
    expect(req.model).toBe('raw-id')
    expect(req.tools?.some((tool) => tool.name === 'bash')).toBe(false)
    if (++round === 1) return { message: { role: 'assistant', content: '', toolCalls: [
      { id: 'one', name: 'write_file', arguments: JSON.stringify({ path: 'src/deep/new.ts', content: 'allowed' }) },
      { id: 'two', name: 'write_file', arguments: JSON.stringify({ path: 'outside.ts', content: 'denied' }) },
      { id: 'three', name: 'write_file', arguments: JSON.stringify({ path: 'src/no.js', content: 'denied' }) },
    ] }, stopReason: 'tool_calls', usage: { inputTokens: 10, outputTokens: 5 } }
    const results = req.messages.filter((message) => message.role === 'tool')
    expect(results).toHaveLength(3)
    expect(results[1]?.content).toContain('denied')
    expect(results[2]?.content).toContain('denied')
    return { message: { role: 'assistant', content: '完成' }, stopReason: 'end', usage: { inputTokens: 20, outputTokens: 5 } }
  } }
  const models = { chosen: { provider: 'local', id: 'raw-id', contextWindow: 100000, price: { input: 2, output: 4 } }, 'raw-id': { provider: 'elsewhere', id: 'wrong-model' } }
  const native = createNativeHarness({ providers: { local: provider }, models })
  const { root, stores, requirementId, deps, profile } = await fixture(native)
  stores.config.providers = { local: { protocol: 'openai-chat' } }
  stores.config.models = models
  profile.harness.model = 'chosen'
  profile.writeScope = ['src/**']
  const state = await createEngine(deps).start({ requirementId, workflow: workflow([agent({ id: 'a', title: '', role: 'dev', prompt: '写入', writeScope: ['**/*.ts'] })]) })
  expect(state.nodes.a?.error).toBeUndefined()
  expect(state.status).toBe('succeeded')
  expect(state.nodes.a?.usage).toMatchObject({ inputTokens: 30, outputTokens: 10, costUsd: 0.0001 })
  expect(await readFile(join(root, 'src/deep/new.ts'), 'utf8')).toBe('allowed')
  await expect(access(join(root, 'outside.ts'))).rejects.toMatchObject({ code: 'ENOENT' })
  await expect(access(join(root, 'src/no.js'))).rejects.toMatchObject({ code: 'ENOENT' })
  expect(await stores.events.read(state.runId, { types: ['guard.violation'] })).toEqual([])
})

it.each([undefined, true])('allowBash 读取角色实现字段 %s，默认 false', async (allowBash) => {
  const { stores, requirementId, deps, profile, harness } = await fixture()
  const native = { ...harness, id: 'native', capabilities: { customProvider: true }, run: async (req: HarnessRequest) => {
    expect(req.tools?.allowBash).toBe(allowBash === true)
    expect(req.tools?.writeScope).toEqual([])
    return { ok: true, finalText: 'done' }
  } }
  deps.harnesses.native = native
  profile.harness = { harness: 'native', provider: 'local', model: 'raw' }
  profile.allowBash = allowBash
  profile.writeScope = ['src/**']
  stores.config.providers = { local: { protocol: 'custom-protocol' } }
  const state = await createEngine(deps).start({ requirementId, workflow: workflow([agent({ id: 'a', title: '', role: 'dev', prompt: '', writeScope: ['test/**'] })]) })
  expect(state.status).toBe('succeeded')
})

it('插件收到角色与节点写范围交集及所选别名的价格窗口，start/resume 只做一次整链校验', async () => {
  const { stores, requirementId, deps, profile, harness } = await fixture()
  const requests: HarnessRequest[] = []
  harness.capabilities = { customProvider: true }
  harness.run = async (req) => { requests.push(req); return { ok: true, finalText: 'done' } }
  profile.writeScope = ['src/**']
  profile.harness.model = 'cheap'
  stores.config.providers = { local: { protocol: 'openai-chat' } }
  let resolutions = 0
  let fallbackResolutions = 0
  const cheap = { provider: 'local', id: 'raw', price: { input: 1, output: 2 }, contextWindow: 1000 }
  const expensive = { ...cheap, price: { input: 10, output: 20 }, contextWindow: 9000 }
  stores.config.models = { get cheap() { resolutions++; return cheap }, get expensive() { resolutions++; return expensive }, get fallback() { fallbackResolutions++; return cheap } }
  profile.harness.fallback = [{ harness: harness.id, model: 'fallback', fallback: [{ harness: harness.id, model: 'fallback' }] }]
  const definition = workflow([agent({ id: 'a', title: '', role: 'dev', prompt: '', writeScope: ['**/*.ts'] })])
  const first = await createEngine(deps).start({ requirementId, workflow: definition })
  expect(first.status).toBe('succeeded')
  // 一次入口校验和一次调用解析，不能在 prepare/CLI/callHarness 再遍历整链。
  expect(resolutions).toBe(2)
  expect(fallbackResolutions).toBe(2)
  expect(requests[0]).toMatchObject({ model: 'raw', modelConfig: { price: cheap.price, contextWindow: 1000 }, tools: { writeScope: ['src/**/*.ts'] } })
  const firstUsage = first.nodes.a!.usage!
  expect(firstUsage.costUsd).toBe((firstUsage.inputTokens + firstUsage.outputTokens * 2) / 1_000_000)
  first.nodes.a!.status = 'stale'
  await stores.runs.save(first)
  profile.harness.model = 'expensive'
  resolutions = 0
  fallbackResolutions = 0
  const resumed = await createEngine(deps).resume(first.runId, definition)
  expect(resumed.status).toBe('succeeded')
  expect(resolutions).toBe(2)
  expect(fallbackResolutions).toBe(2)
  expect(requests[1]?.modelConfig).toEqual({ price: { input: 10, output: 20 }, contextWindow: 9000 })
  const resumedUsage = resumed.nodes.a!.usage!
  expect(resumedUsage.costUsd).toBe((resumedUsage.inputTokens * 10 + resumedUsage.outputTokens * 20) / 1_000_000)
})

it('新引擎恢复不支持 resume 的适配器：忽略旧 session 并注入落盘产物清单', async () => {
  const { stores, requirementId, deps, harness } = await fixture()
  harness.capabilities = { resume: false }
  harness.run = async (req) => {
    await writeFile(join(req.env!.TAKT_WORKSPACE!, 'result.txt'), 'first')
    return { ok: true, finalText: 'done', sessionId: 'old-session' }
  }
  const definition = workflow([agent({ id: 'a', title: '', role: 'dev', prompt: '', session: 'resume', outputs: [{ path: 'result.txt', kind: 'report' }] })])
  const first = await createEngine(deps).start({ requirementId, workflow: definition })
  first.nodes.a!.status = 'stale'
  await stores.runs.save(first)
  const replacement: HarnessAdapter = { ...harness, run: async (req) => {
    expect(req.sessionId).toBeUndefined()
    expect(req.prompt).toContain(`${requirementId}/result.txt (version 1)`)
    return { ok: true, finalText: 'continued', sessionId: 'new-session' }
  } }
  const resumed = await createEngine({ ...deps, stores: await openProject(stores.projectDir), harnesses: { [harness.id]: replacement } }).resume(first.runId, definition)
  expect(resumed.status).toBe('succeeded')
  expect(resumed.nodes.a?.sessionRef?.sessionId).toBe('new-session')
})

it('无 resume 的循环新会话在调用前带上一轮产物，schema 不透传但仍文本提取校验，用量每轮重新估算', async () => {
  const calls: HarnessRequest[] = []
  const { stores, requirementId, deps, harness } = await fixture()
  harness.run = async (req, emit) => {
    calls.push(req)
    expect(req.sessionId).toBeUndefined()
    expect(req.resultSchema).toBeUndefined()
    if (calls.length === 2) {
      expect(req.prompt).toContain(`${requirementId}/result.txt (version 1)`)
      const audit = await stores.events.read(req.env!.TAKT_RUN_ID!, { nodeId: 'l/a', types: ['harness.message'] })
      expect(audit.at(-1)?.data).toMatchObject({ text: req.prompt })
    }
    await writeFile(join(req.env!.TAKT_WORKSPACE!, 'result.txt'), `round ${calls.length}`)
    emit({ type: 'usage', usage: { inputTokens: 999, outputTokens: 999 } })
    return { ok: true, finalText: '```json\n{"ok":true}\n```', sessionId: `session-${calls.length}` }
  }
  const definition = workflow([loop({ id: 'l', title: '', maxIterations: 2, until: (ctx) => ctx.iteration === 2, body: [agent({ id: 'a', title: '', role: 'dev', prompt: '完成', session: 'resume', outputs: [{ path: 'result.txt', kind: 'report' }], resultSchema: { type: 'object', required: ['ok'], properties: { ok: { type: 'boolean' } } } })] })])
  const state = await createEngine(deps).start({ requirementId, workflow: definition })
  expect(state.status).toBe('succeeded')
  expect(calls).toHaveLength(2)
  expect(state.nodes['l/a']?.result).toEqual({ ok: true })
  const usage = await stores.events.read(state.runId, { types: ['harness.usage'] })
  expect(usage).toHaveLength(2)
  for (const [index, event] of usage.entries()) expect(event.data).toMatchObject({
    inputTokens: estimateTokens(calls[index]!.systemAppend!) + estimateTokens(calls[index]!.prompt),
    outputTokens: estimateTokens('```json\n{"ok":true}\n```'), note: 'estimated',
  })
  expect(await stores.events.verify(state.runId)).toEqual({ ok: true })
})

it('支持 resume 时恢复 session；fallback 不串用 session，节点累计本轮各调用用量', async () => {
  const { stores, requirementId, deps, harness, profile } = await fixture()
  const calls: HarnessRequest[] = []
  harness.capabilities = { resume: true, usage: true }
  harness.run = async (req, emit) => {
    calls.push(req)
    if (calls.length === 1) return { ok: true, finalText: 'first', sessionId: 'previous', usage: { inputTokens: 900, outputTokens: 800 } }
    expect(req.sessionId).toBe('previous')
    emit({ type: 'usage', usage: { inputTokens: 777, outputTokens: 777 } })
    return { ok: false, finalText: '', error: '429' }
  }
  const fallback: HarnessAdapter = { id: 'fallback', displayName: '', available: async () => ({ ok: true }), run: async (req) => {
    expect(req.sessionId).toBeUndefined()
    return { ok: true, finalText: 'fallback' }
  } }
  deps.harnesses.fallback = fallback
  profile.harness.fallback = [{ harness: 'fallback' }]
  const def = workflow([agent({ id: 'a', title: '', role: 'dev', prompt: '', session: 'resume' })])
  const state = await createEngine(deps).start({ requirementId, workflow: def })
  state.nodes.a!.status = 'stale'
  await stores.runs.save(state)
  const resumed = await createEngine(deps).resume(state.runId, def)
  expect(resumed.status).toBe('succeeded')
  expect(resumed.nodes.a!.usage!.inputTokens).not.toBe(777)
  expect(resumed.nodes.a!.usage!.outputTokens).toBe(777 + estimateTokens('fallback'))
  expect((await stores.events.read(state.runId, { types: ['harness.usage'] })).at(-1)?.data).toMatchObject({ note: 'estimated' })
})

it.each([false, true])('覆盖 provider 后估算成本只来自目标模型 metadata，存在=%s', async (matching) => {
  const { stores, requirementId, deps, harness, profile } = await fixture()
  harness.capabilities = { customProvider: true }
  stores.config.providers = { a: { protocol: 'openai-chat' }, b: { protocol: 'openai-chat' } }
  stores.config.models = { alias: { id: 'raw', provider: 'a', price: { input: 999, output: 999 } },
    ...(matching ? { other: { id: 'raw', provider: 'b', price: { input: 1, output: 2 } } } : {}),
  }
  profile.harness = { harness: harness.id, provider: 'b', model: 'alias' }
  harness.run = async (req) => {
    expect(req.model).toBe('raw')
    expect(req.provider?.id).toBe('b')
    return { ok: true, finalText: 'done' }
  }
  const state = await createEngine(deps).start({ requirementId, workflow: workflow([agent({ id: 'a', title: '', role: 'dev', prompt: '' })]) })
  expect(state.status).toBe('succeeded')
  const usage = state.nodes.a!.usage!
  if (matching) expect(usage.costUsd).toBe((usage.inputTokens + 2 * usage.outputTokens) / 1_000_000)
  else expect(usage.costUsd).toBeUndefined()
})

it('无 schema 能力的 legacy adapter structured 结果仍优先，文本 fallback 拒绝不合法 schema', async () => {
  const { requirementId, deps, harness } = await fixture()
  let count = 0
  harness.run = async (req) => {
    expect(req.resultSchema).toBeUndefined()
    return ++count === 1 ? { ok: true, finalText: '', structured: { ok: true } } : { ok: true, finalText: '```json\n{"ok":"bad"}\n```' }
  }
  const state = await createEngine(deps, { concurrency: 1 }).start({ requirementId, workflow: workflow(['a', 'b'].map((id) => agent({ id, title: '', role: 'dev', prompt: '', resultSchema: { type: 'object', properties: { ok: { type: 'boolean' } } } }))) })
  expect(state.nodes.a?.result).toEqual({ ok: true })
  expect(state.nodes.b?.status).toBe('failed')
})

it('planner 快照顶层全限定、body 相对 ID；换实例恢复与旧记录迁移都保留元数据，拒绝同 ID 改定义', async () => {
  const { root, stores, requirementId, deps, harness } = await fixture()
  let calls = 0
  harness.run = async () => { calls++; return { ok: true, finalText: '', structured: { items: [{ key: 'x', title: 'X' }] } } }
  const body = [script({ id: 'before', title: '准备', run: async () => {} }), human({ id: 'review', title: '审核', needs: ['before'], ask: '审核', form: 'approve' })]
  const definition = workflow([planner({ id: 'p', title: '', role: 'dev', prompt: '', maxItems: 1, expand: () => [loop({ id: 'l', title: '循环', body, maxIterations: 1, until: () => true })] })])
  const first = await createEngine(deps).start({ requirementId, workflow: definition })
  const expansion = structuredClone(first.expansions[0]!)
  expect(expansion.nodes).toMatchObject([{ id: 'p/x/l', kind: 'loop', body: [{ id: 'before' }, { id: 'review', needs: ['before'] }] }])
  expect((await stores.events.read(first.runId, { types: ['dag.expanded'] }))[0]?.data).toEqual(expansion)
  const file = join(root, '.takt/runs', first.runId, 'engine.json')
  const metadata = JSON.parse(await readFile(file, 'utf8'))
  expect(metadata.nodes).toBeUndefined()
  expect(metadata.requests['p/x/l/review']).toBeTruthy()
  await expect(createEngine(deps).resume(first.runId, workflow([planner({ ...definition.nodes[0] as Parameters<typeof planner>[0], expand: () => [loop({ id: 'l', title: '变更', body, maxIterations: 1, until: () => true })] })]))).rejects.toThrow('展开定义已改变')
  // 模拟历史记录只有 nodeIds 与旧 engine.json.nodes，新恢复会补入快照而不再写临时图。
  delete first.expansions[0]!.nodes
  await stores.runs.save(first)
  await writeFile(file, JSON.stringify({ ...metadata, nodes: [{ id: 'p/x/l', kind: 'loop', title: '循环', needs: [], parent: 'p' }] }))
  const pending = (await stores.attention.list({ pending: true }))[0]!
  await stores.attention.answer(pending.requestId, { decision: 'approve', by: { type: 'human', id: 'tester' } })
  const resumed = await createEngine({ ...deps, stores: await openProject(root) }).resume(first.runId, definition)
  expect(resumed.status).toBe('succeeded')
  expect(resumed.expansions[0]?.nodes).toEqual(expansion.nodes)
  expect(calls).toBe(1)
  expect(JSON.parse(await readFile(file, 'utf8')).nodes).toBeUndefined()
  expect(JSON.parse(await readFile(file, 'utf8')).requests).toEqual(metadata.requests)
})

it('workflow 开始前拒绝无效 fallback，不创建运行、不探测 harness', async () => {
  const { stores, requirementId, deps, harness, profile } = await fixture()
  harness.available = async () => { throw new Error('不应探测 harness') }
  profile.harness.fallback = [{ harness: 'missing' }]
  await expect(createEngine(deps).start({ requirementId, workflow: workflow([agent({ id: 'a', title: '', role: 'dev', prompt: '' })]) })).rejects.toThrow('harness 不存在')
  expect(await stores.runs.list()).toEqual([])
})

it('planner 动态子图在任何子任务执行前校验，拒绝无效模型并保持未展开', async () => {
  const { requirementId, deps, harness } = await fixture()
  harness.run = async () => ({ ok: true, finalText: '', structured: { items: [{ key: 'x', title: '' }] } })
  let executions = 0
  const state = await createEngine(deps).start({ requirementId, workflow: workflow([planner({ id: 'p', title: '', role: 'dev', maxItems: 1, prompt: '', expand: () => [
    script({ id: 'side-effect', title: '', run: async () => { executions++ } }),
    agent({ id: 'invalid', title: '', role: 'dev', harness: { harness: 'missing' }, prompt: '' }),
  ] })]) })
  expect(state.nodes.p?.status).toBe('failed')
  expect(state.nodes.p?.error).toContain('harness 不存在')
  expect(executions).toBe(0)
  expect(state.expansions).toEqual([])
  expect(Object.keys(state.nodes)).toEqual(['p'])
})
