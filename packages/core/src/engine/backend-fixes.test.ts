import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { agent, human, loop, planner, script } from '../dsl.js'
import type { AttentionItem } from '../interfaces.js'
import { markArtifactEdited } from '../store/artifact-edits.js'
import { initProject, openProject } from '../store/project.js'
import { AttentionAlreadyAnsweredError } from '../store/attention-rules.js'
import type { AgentProfile, HarnessAdapter, NodeDef, WorkflowDefinition } from '../types.js'
import { answerOrRead, recordAnswerOnce } from './answers.js'
import { createEngine } from './index.js'
import { WriteGuard } from './guard.js'
import { parseResult } from './schema.js'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))) })
const profile: AgentProfile = { role: 'dev', title: '开发', description: '', instructions: '只出现一次的角色说明', skills: [], writeScope: [], harness: { harness: 'mock' } }
const workflow = (nodes: NodeDef[]): WorkflowDefinition => ({ id: 'fixes', title: '修复', version: '1', stages: [{ id: 'delivery', title: '交付' }], nodes })
async function fixture(run: HarnessAdapter['run'] = async () => ({ ok: true, finalText: '' })) {
  const root = await mkdtemp(join(tmpdir(), 'takt-backend-fixes-'))
  roots.push(root)
  const stores = await initProject(root)
  const requirementId = (await stores.workspaces.createRequirement({ title: '回归' })).id
  const deps = { stores, profiles: { dev: profile }, knowledge: [], harnesses: { mock: { id: 'mock', displayName: '', capabilities: { usage: true }, available: async () => ({ ok: true }), run } } }
  return { root, stores, requirementId, deps }
}

it('prompt 审计先于调用，角色只进入 system，原生 structured 优先且流式消息不放大 save', async () => {
  const { stores, requirementId, deps } = await fixture(async (req, onEvent) => {
    expect(req.prompt).not.toContain(profile.instructions)
    expect(req.systemAppend).toBe(profile.instructions)
    const events = await stores.events.read(req.env!.TAKT_RUN_ID!, { types: ['harness.message'] })
    expect(events.at(-1)?.data).toEqual({ role: 'user', text: req.prompt })
    onEvent({ type: 'started', sessionId: 'native-session' })
    for (let i = 0; i < 30; i++) {
      onEvent({ type: 'message', role: 'assistant', text: `fragment-${i}` })
      onEvent({ type: 'tool_call', tool: 'read', input: String(i) })
    }
    onEvent({ type: 'usage', usage: { inputTokens: 7, outputTokens: 9 } })
    return { ok: true, finalText: '不是 JSON', structured: { ok: true }, usage: { inputTokens: 8, outputTokens: 10 } }
  })
  const save = vi.spyOn(stores.runs, 'save')
  const state = await createEngine(deps).start({ requirementId, workflow: workflow([agent({ id: 'a', title: '', stage: 'delivery', role: 'dev', prompt: '任务', resultSchema: { type: 'object', required: ['ok'], properties: { ok: { type: 'boolean' } } } })]) })
  expect(state.status).toBe('succeeded')
  expect(save.mock.calls.length).toBeLessThan(15)
  expect((await stores.runs.get(state.runId))?.nodes.a).toMatchObject({ result: { ok: true }, sessionRef: { sessionId: 'native-session' }, usage: { inputTokens: 8, outputTokens: 10 } })
  expect((await stores.runs.getContext(state.runId, 'a')).snapshots[0]?.items.filter((item) => item.source === 'role')).toHaveLength(1)
  expect(await stores.events.verify(state.runId)).toEqual({ ok: true })
})

it.each([null, { ok: 'wrong' }])('原生 structured 仍需校验 schema：%s', async (structured) => {
  const { requirementId, deps } = await fixture(async () => ({ ok: true, finalText: '```json\n{"ok":true}\n```', structured }))
  const state = await createEngine(deps).start({ requirementId, workflow: workflow([agent({ id: 'a', title: '', role: 'dev', prompt: '', resultSchema: { type: 'object', properties: { ok: { type: 'boolean' } } } })]) })
  expect(state.nodes.a?.status).toBe('failed')
})

it.each(['```json\n{"ok":false}', '```json\ninvalid\n```'])('拒绝无效的最后 fence，不回退较早有效块', (last) => {
  expect(() => parseResult('```json\n{"ok":true}\n```\n' + last, { type: 'object' })).toThrow('最后 json')
})

it('知识使用共享路由推断 intent、去重限额并记录真实来源', async () => {
  const { requirementId, deps, stores } = await fixture(async (req) => {
    expect(req.prompt).toContain('高分证据')
    expect(req.prompt).not.toContain('低分证据')
    return { ok: true, finalText: '' }
  })
  const unused = vi.fn(async () => [])
  const state = await createEngine({ ...deps, knowledge: [
    { id: 'symbols', kind: 'grep', intents: ['symbol'], describe: () => '', query: async () => [
      { sourceId: 'symbols', ref: 'code', title: 'code', snippet: '低分证据', score: 1 },
      { sourceId: 'symbols', ref: 'code', title: 'code', snippet: '高分证据', score: 2 },
    ] },
    { id: 'business', kind: 'wiki', intents: ['business'], describe: () => '', query: unused },
  ] }).start({ requirementId, workflow: workflow([agent({ id: 'a', title: '', role: 'dev', prompt: '', knowledge: [{ text: 'lookupSymbol()', limit: 1 }] })]) })
  expect(state.status).toBe('succeeded')
  expect(unused).not.toHaveBeenCalled()
  expect((await stores.events.read(state.runId, { types: ['knowledge.query'] }))[0]?.data).toMatchObject({ sources: ['symbols'], hits: 1 })
})

it('恢复人工回答使用 answeredBy，跨 runtime 去重，不吞非冲突错误', async () => {
  const { stores, requirementId, deps } = await fixture()
  const def = workflow([human({ id: 'h', title: '', ask: '?', form: 'approve' })])
  const state = await createEngine(deps).start({ requirementId, workflow: def })
  const item = (await stores.attention.list())[0]!
  const actor = { type: 'human', id: 'actual-reviewer' } as const
  const answered = await stores.attention.answer(item.requestId, { decision: 'approve', by: actor })
  await Promise.all(Array.from({ length: 5 }, () => recordAnswerOnce(stores, state.runId, answered)))
  await createEngine(deps).resume(state.runId, def)
  const events = await stores.events.read(state.runId, { types: ['human.answered'] })
  expect(events).toHaveLength(1)
  expect(events[0]?.actor).toEqual(actor)
  expect((await answerOrRead(stores, item, { decision: 'cancelled', by: { type: 'system', id: 'engine' } })).answeredBy).toEqual(actor)
  vi.spyOn(stores.attention, 'answer').mockRejectedValueOnce(new Error('disk unavailable'))
  await expect(answerOrRead(stores, item, { decision: 'approve', by: actor })).rejects.toThrow('disk unavailable')
  vi.spyOn(stores.attention, 'answer').mockRejectedValueOnce(new AttentionAlreadyAnsweredError(item.requestId))
  vi.spyOn(stores.attention, 'list').mockResolvedValueOnce([item])
  await expect(answerOrRead(stores, item, { decision: 'approve', by: actor })).rejects.toBeInstanceOf(AttentionAlreadyAnsweredError)
})

it('遗留回答没有 actor 时才使用 system', async () => {
  const { stores, requirementId, deps } = await fixture()
  const state = await createEngine(deps).start({ requirementId, workflow: workflow([]) })
  const legacy: AttentionItem = { requestId: 'legacy', runId: state.runId, nodeId: 'old', requirementId, ask: '', form: 'approve', createdAt: '', answeredAt: 'now', decision: 'approve' }
  await recordAnswerOnce(stores, state.runId, legacy)
  expect((await stores.events.read(state.runId, { types: ['human.answered'] }))[0]?.actor).toEqual({ type: 'system', id: 'engine' })
})

it('新运行覆盖已交付状态，旧运行晚完成不覆盖最新等待状态，cancel 更新需求', async () => {
  const { stores, requirementId, deps } = await fixture()
  await stores.workspaces.updateRequirement(requirementId, { status: 'delivered' })
  let entered!: () => void
  const started = new Promise<void>((resolve) => { entered = resolve })
  let release!: () => void
  const barrier = new Promise<void>((resolve) => { release = resolve })
  const old = createEngine(deps, { now: () => new Date('2026-11-04T01:00:00Z') }).start({ requirementId, workflow: workflow([
    script({ id: 'old', title: '', stage: 'delivery', run: async () => { entered(); await barrier } }),
  ]) })
  await started
  expect((await stores.workspaces.getRequirement(requirementId))?.status).toBe('active')
  const engine = createEngine(deps, { now: () => new Date('2026-11-04T02:00:00Z') })
  const newer = await engine.start({ requirementId, workflow: workflow([human({ id: 'wait', title: '', stage: 'delivery', ask: '?', form: 'approve' })]) })
  release()
  expect((await old).status).toBe('succeeded')
  expect(await stores.workspaces.getRequirement(requirementId)).toMatchObject({ status: 'active', stage: 'delivery' })
  await engine.cancel(newer.runId)
  expect((await stores.workspaces.getRequirement(requirementId))?.status).toBe('blocked')
  await createEngine(deps, { now: () => new Date('2026-11-04T03:00:00Z') }).start({ requirementId, workflow: workflow([script({ id: 'done', title: '', stage: 'delivery', run: async () => undefined })]) })
  expect((await stores.workspaces.getRequirement(requirementId))?.status).toBe('delivered')
})

it.each([['返回失败结果', 'result'], ['抛出异常', 'throw']] as const)('带阶段脚本%s时运行与节点失败，需求持久化为 blocked 并停在失败阶段', async (_mode, kind) => {
  const { root, stores, requirementId, deps } = await fixture()
  expect((await stores.workspaces.getRequirement(requirementId))?.status).toBe('draft')
  const run = kind === 'result'
    ? async () => ({ status: 'failed' as const, message: '缺少证据' })
    : async () => { throw new Error('脚本执行崩溃') }
  const state = await createEngine(deps).start({ requirementId, workflow: workflow([
    script({ id: 'boom', title: '失败脚本', stage: 'delivery', run }),
  ]) })
  expect(state.status).toBe('failed')
  expect(state.nodes.boom).toMatchObject({ status: 'failed', error: kind === 'result' ? '缺少证据' : '脚本执行崩溃' })
  const reopened = await openProject(root)
  expect(await reopened.workspaces.getRequirement(requirementId)).toMatchObject({ status: 'blocked', stage: 'delivery' })
})

it('动态 planner 记录子节点完整元信息及条目间依赖，loop 保留 parent', async () => {
  const { root, stores, requirementId, deps } = await fixture(async () => ({ ok: true, finalText: '', structured: { items: [{ key: 'a', title: 'A' }, { key: 'b', title: 'B', dependsOn: ['a'] }] } }))
  const state = await createEngine(deps).start({ requirementId, workflow: workflow([
    planner({ id: 'p', title: 'Planner', role: 'dev', stage: 'delivery', maxItems: 2, prompt: '', expand: () => [human({ id: 'h', title: 'Review', stage: 'delivery', ask: '', form: 'approve' })] }),
    loop({ id: 'l', title: 'Loop', body: [script({ id: 's', title: 'Script', run: async () => undefined })], maxIterations: 1, until: () => true }),
  ]) })
  const metadata = JSON.parse(await readFile(join(root, '.takt/runs', state.runId, 'engine.json'), 'utf8')) as { nodes?: unknown[]; requests: Record<string, string> }
  expect(metadata.nodes).toBeUndefined()
  expect(metadata.requests['p/a/h']).toBeTruthy()
  expect((await stores.runs.get(state.runId))?.expansions[0]?.nodes).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: 'p/a/h', kind: 'human', title: 'Review', stage: 'delivery', needs: [] }),
    expect.objectContaining({ id: 'p/b/h', kind: 'human', title: 'Review', stage: 'delivery', needs: ['p/a/h'] }),
  ]))
  const snapshot = await stores.runs.getWorkflow(state.runId)
  expect(snapshot?.nodes.find((node) => node.id === 'p')).toMatchObject({ kind: 'planner', title: 'Planner', role: 'dev' })
  expect(snapshot?.nodes.find((node) => node.id === 'l')?.body).toEqual([expect.objectContaining({ id: 's', kind: 'script', title: 'Script' })])
  expect(await stores.events.verify(state.runId)).toEqual({ ok: true })
})

it('守卫保留 dirty/staged/untracked 和执行期间人工写入，不恢复成 HEAD/index', async () => {
  const { root } = await fixture()
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root })
  git('init', '--quiet')
  for (const file of ['dirty.txt', 'staged.txt', 'human.txt']) await writeFile(join(root, file), 'HEAD')
  git('add', 'dirty.txt', 'staged.txt', 'human.txt')
  git('-c', 'user.name=test', '-c', 'user.email=test@example.invalid', 'commit', '--quiet', '-m', 'fixture')
  await writeFile(join(root, 'dirty.txt'), '用户未暂存')
  await writeFile(join(root, 'staged.txt'), '用户已暂存')
  git('add', 'staged.txt')
  await writeFile(join(root, 'untracked.txt'), '用户新文件')
  const guard = new WriteGuard(root)
  const finish = await guard.begin({ profile: [] })
  for (const file of ['dirty.txt', 'staged.txt', 'untracked.txt', 'human.txt']) await writeFile(join(root, file), `最新-${file}`)
  const result = await finish()
  expect(result.action).toBe('flagged')
  expect(result.paths).toEqual(expect.arrayContaining(['dirty.txt', 'staged.txt', 'untracked.txt', 'human.txt']))
  for (const file of result.paths) expect(await readFile(join(root, file), 'utf8')).toBe(`最新-${file}`)
  expect(git('show', ':staged.txt').toString()).toBe('用户已暂存')
})

it('有范围的系统窗口只豁免其写路径；并发未声明写保留并标记归因不明，attention lock 忽略', async () => {
  const { root } = await fixture()
  const guard = new WriteGuard(root)
  const finish = await guard.begin({ profile: [] })
  await guard.system(['declared.txt'], async () => {
    await writeFile(join(root, 'declared.txt'), '合法脚本输出')
    await writeFile(join(root, 'unknown.txt'), '未声明脚本输出')
  }, true)
  await writeFile(join(root, '.takt/attention.jsonl.lock'), '锁')
  const result = await finish()
  expect(result).toEqual({ paths: ['unknown.txt'], action: 'flagged', ambiguous: true })
  expect(await readFile(join(root, 'unknown.txt'), 'utf8')).toBe('未声明脚本输出')
})


it('外部 store 编辑的失效记录在旧 runtime 落盘后仍保留，planner 父和下游可完成新尝试', async () => {
  const { root, stores, requirementId, deps } = await fixture(async () => ({ ok: true, finalText: '', structured: { items: [{ key: 'a', title: 'A' }] } }))
  const ref = { workspace: requirementId, path: 'input.txt' }
  await stores.workspaces.writeArtifact({ ref, kind: 'input', content: 'v1', author: { type: 'system', id: 'test' } })
  let entered!: () => void
  let release!: () => void
  const started = new Promise<void>((resolve) => { entered = resolve })
  const barrier = new Promise<void>((resolve) => { release = resolve })
  let calls = 0
  let downstream = 0
  const def = workflow([
    planner({ id: 'p', title: 'plan', role: 'dev', prompt: '', maxItems: 1, expand: () => [
      script({ id: 'read', title: '', inputs: [{ path: 'input.txt' }], run: async (ctx) => {
        if (++calls === 1) { entered(); await barrier }
        return { data: await ctx.readArtifact('input.txt') }
      } }),
    ] }),
    script({ id: 'after', title: '', needs: ['p'], stage: 'delivery', run: async () => { downstream++ } }),
  ])
  const active = createEngine(deps).start({ requirementId, workflow: def })
  await started
  const external = await openProject(root)
  const cause = await external.workspaces.writeArtifact({ ref, kind: 'input', content: 'v2', author: { type: 'human', id: 'editor' }, reason: '新规格' })
  const marked = await markArtifactEdited(external, cause, { type: 'human', id: 'editor' }, '新规格')
  expect(marked.map((item) => item.nodeId).sort()).toEqual(['after', 'p', 'p/a/read'])
  release()
  const old = await active
  expect(old.nodes['p/a/read']?.status).toBe('stale')
  expect(old.nodes.p?.status).toBe('stale')
  expect(old.nodes.after?.status).toBe('stale')
  expect(downstream).toBe(0)
  const rerun = await createEngine({ ...deps, stores: await openProject(root) }).resume(old.runId, def)
  expect(rerun.status).toBe('succeeded')
  expect(rerun.nodes['p/a/read']).toMatchObject({ status: 'succeeded', result: 'v2', attempts: 2, inputs: [{ ...ref, version: 2 }] })
  expect(calls).toBe(2)
  expect(downstream).toBe(1)
  expect((await external.runs.get(old.runId))?.status).toBe('succeeded')
})

it('窗口内 manifest 记载的人工新版本归因 system，保留人工内容', async () => {
  let edit!: () => Promise<void>
  const { stores, requirementId, deps } = await fixture(async () => { await edit(); return { ok: true, finalText: '' } })
  edit = async () => {
    await stores.workspaces.writeArtifact({ ref: { workspace: requirementId, path: 'manual.txt' }, content: '人工内容', kind: 'input', author: { type: 'human', id: 'editor' }, reason: '更新' })
  }
  const state = await createEngine(deps).start({ requirementId, workflow: workflow([agent({ id: 'a', title: '', role: 'dev', prompt: '' })]) })
  const [violation] = await stores.events.read(state.runId, { types: ['guard.violation'] })
  expect(violation?.actor).toEqual({ type: 'system', id: 'engine' })
  expect(violation?.data).toMatchObject({ rule: 'concurrent-write', action: 'flagged' })
  expect((await stores.workspaces.readArtifact({ workspace: requirementId, path: 'manual.txt' }))?.toString()).toBe('人工内容')
})

it('执行中的 harness 遇外部人工改版，晚到 succeeded 不覆盖 stale，resume 消费新版本', async () => {
  let entered!: () => void
  let release!: () => void
  const started = new Promise<void>((resolve) => { entered = resolve })
  const barrier = new Promise<void>((resolve) => { release = resolve })
  let calls = 0
  const { root, stores, requirementId, deps } = await fixture(async () => {
    if (++calls === 1) { entered(); await barrier }
    return { ok: true, finalText: '完成' }
  })
  const ref = { workspace: requirementId, path: 'spec.txt' }
  await stores.workspaces.writeArtifact({ ref, content: 'v1', kind: 'spec', author: { type: 'system', id: 'test' } })
  const def = workflow([agent({ id: 'a', title: '', role: 'dev', prompt: '', stage: 'delivery', inputs: [{ path: 'spec.txt' }] })])
  const pending = createEngine(deps).start({ requirementId, workflow: def })
  await started
  const external = await openProject(root)
  const cause = await external.workspaces.writeArtifact({ ref, content: 'v2', kind: 'spec', author: { type: 'human', id: 'editor' }, reason: '更新' })
  await markArtifactEdited(external, cause, { type: 'human', id: 'editor' }, '更新')
  release()
  const old = await pending
  expect(old.nodes.a?.status).toBe('stale')
  const next = await createEngine({ ...deps, stores: await openProject(root) }).resume(old.runId, def)
  expect(next.status).toBe('succeeded')
  expect(next.nodes.a).toMatchObject({ attempts: 2, inputs: [{ ...ref, version: 2 }] })
  expect(calls).toBe(2)
})

it('并发脚本声明的产物写入不归因只读 agent，未知脚本写入保留并归因 system', async () => {
  for (const declared of [true, false]) {
    let entered!: () => void
    let release!: () => void
    const started = new Promise<void>((resolve) => { entered = resolve })
    const barrier = new Promise<void>((resolve) => { release = resolve })
    const { stores, requirementId, deps } = await fixture(async () => { entered(); await barrier; return { ok: true, finalText: '' } })
    const state = await createEngine(deps).start({ requirementId, workflow: workflow([
      agent({ id: 'a', title: '', role: 'dev', prompt: '' }),
      script({ id: 'writer', title: '', outputs: declared ? [{ path: 'script.txt', kind: 'report' }] : [], run: async (ctx) => {
        await started
        await writeFile(join(ctx.workspaceDir, 'script.txt'), '脚本内容')
        release()
      } }),
    ]) })
    const events = await stores.events.read(state.runId, { types: ['guard.violation'] })
    if (declared) {
      expect(state.status).toBe('succeeded')
      expect(events).toEqual([])
    } else {
      expect(events[0]?.actor).toEqual({ type: 'system', id: 'engine' })
      expect(events[0]?.data).toMatchObject({ rule: 'concurrent-write', action: 'flagged' })
    }
    expect(await readFile(join(stores.workspaces.dir(requirementId), 'script.txt'), 'utf8')).toBe('脚本内容')
  }
})
