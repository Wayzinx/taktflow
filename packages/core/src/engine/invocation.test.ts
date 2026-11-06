import { removeTestProject } from './test-cleanup.js'
import { chmod, mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { agent, defineWorkflow, gate, judge, review, script } from '../dsl.js'
import { initProject } from '../store/project.js'
import { getObject } from '../store/objects.js'
import { canonicalJson, sha256 } from '../util/hash.js'
import type { AgentProfile, EventPayloads, HarnessAdapter, HarnessRequest, HarnessResult, NodeDef, ReviewNodeDef } from '../types.js'
import { createEngine } from './index.js'
import type { CapturedInputSnapshot, CapturedInvocation } from './capture-types.js'
import { RENDERER_VERSION, renderRequest, type PromptParams } from './prompt-renderer.js'
import { assignIssues } from './nodes/review-issues.js'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => removeTestProject(root))) })
const approve = { verdict: 'approve', summary: '通过', issues: [], previous: [] }
const workflow = (nodes: NodeDef[]) => defineWorkflow({ id: 'capture', title: '采集测试', version: '1', stages: [], nodes })
const reviewer = (patch: Partial<ReviewNodeDef> = {}) => review({ id: 'review', title: '文档评审', target: ['spec.md'], references: ['reference.md'],
  author: { role: 'author' }, reviewers: [{ role: 'r1', focus: '输入和输出', checklist: ['验收标准有明确期望'] }], maxRounds: 1, onExhausted: 'fail', ...patch })
async function fixture(handler: (req: HarnessRequest) => Promise<unknown> = async () => approve) {
  const root = await mkdtemp(join(tmpdir(), 'takt-invocation-')); roots.push(root)
  const stores = await initProject(root)
  const requirementId = (await stores.workspaces.createRequirement({ title: '缺陷采集' })).id
  for (const path of ['spec.md', 'reference.md']) await stores.workspaces.writeArtifact({ ref: { workspace: requirementId, path }, content: `${path} v1`, kind: 'spec', author: { type: 'system', id: 'test' } })
  const calls: HarnessRequest[] = []
  const mock: HarnessAdapter = { id: 'mock', displayName: 'mock', capabilities: { structuredOutput: true }, available: async () => ({ ok: true }), run: async (req) => {
    calls.push(req); return { ok: true, finalText: '', structured: await handler(req) }
  } }
  const profiles = Object.fromEntries(['author', 'r1', 'r2'].map((role): [string, AgentProfile] => [role, { role, title: role, description: '', instructions: role, skills: [], writeScope: ['requirements/**'], harness: { harness: 'mock' } }]))
  const deps = { stores, profiles, knowledge: [], harnesses: { mock } as Record<string, HarnessAdapter> }
  const start = (nodes: NodeDef[]) => createEngine(deps).start({ requirementId, workflow: workflow(nodes) })
  const started = async (runId: string) => (await stores.events.read(runId, { types: ['invocation.started'] })).map((event) => ({ seq: event.seq, ...event.data as EventPayloads['invocation.started'] }))
  return { root, stores, requirementId, calls, deps, start, started }
}

it('先调度两评审者，第二个失败时第一个 review.result 已落盘；快照版本、hash、权限一致', async () => {
  const f = await fixture(async (req) => {
    const runId = req.env!.TAKT_RUN_ID!
    const events = await f.stores.events.read(runId)
    expect(events.filter((event) => event.type === 'checkpoint.scheduled')).toHaveLength(2)
    if (req.env!.TAKT_ROLE === 'r2') {
      expect(events.filter((event) => event.type === 'review.result')).toHaveLength(1)
      throw new Error('second reviewer failed')
    }
    const event = events.find((event) => event.type === 'invocation.started')!
    const { invocation, inputSnapshot } = event.data as EventPayloads['invocation.started']
    expect(invocation.invocationId).toBe(`${runId}:${event.seq}`)
    expect(inputSnapshot.inputs.map((item) => item.role)).toEqual(['target', 'reference'])
    for (const item of inputSnapshot.inputs) {
      const path = join(req.env!.TAKT_WORKSPACE!, item.ref.path)
      expect(req.prompt).toContain(path)
      expect(path).toContain('/.takt/quality/snapshots/')
      expect(sha256(await readFile(path))).toBe(item.sha256)
      expect((await stat(path)).mode & 0o222).toBe(0)
    }
    expect(req.prompt).not.toContain(`公共存放区：${f.stores.workspaces.dir(f.requirementId)}`)
    return approve
  })
  const state = await f.start([reviewer({ reviewers: [{ role: 'r1' }, { role: 'r2' }] })])
  expect(state.status).toBe('failed')
  expect((await f.stores.events.read(state.runId, { types: ['review.result'] }))).toHaveLength(1)
  const finishes = await f.stores.events.read(state.runId, { types: ['invocation.finished'] })
  expect(finishes.map((event) => (event.data as EventPayloads['invocation.finished']).outcome.status)).toEqual(['ok', 'error'])
  expect(await f.stores.events.verify(state.runId)).toEqual({ ok: true })
})

it('fallback 每个实际 run 一条调用，同配方跨运行 ID 相同；内容复用和修改仍关联调用', async () => {
  let content = 'unchanged'
  const f = await fixture(async (req) => { await writeFile(join(req.env!.TAKT_WORKSPACE!, 'out.md'), content); return 'done' })
  f.deps.harnesses.first = { id: 'first', displayName: 'first', available: async () => ({ ok: true }), run: async () => ({ ok: false, finalText: '', error: '503 retry' }) }
  const nodes = [agent({ id: 'write', title: '写入', role: 'author', prompt: '相同的静态任务', outputs: [{ path: 'out.md', kind: 'spec' }], harness: { harness: 'first', fallback: [{ harness: 'mock' }] } })]
  const states = [await f.start(nodes), await f.start(nodes)]
  content = 'modified'
  states.push(await f.start(nodes))
  const captures = []
  for (const state of states) {
    expect(state.status).toBe('succeeded')
    const events = await f.started(state.runId)
    expect(events).toHaveLength(2)
    expect(events.map((event) => event.invocation.fallbackIndex)).toEqual([0, 1])
    for (const event of events) {
      expect(event.invocation.invocationId).toBe(`${state.runId}:${event.seq}`)
      const { recipeId, ...fields } = event.recipe
      expect(recipeId).toBe(sha256(canonicalJson(fields)))
      const { inputSnapshotId, ...input } = event.inputSnapshot
      expect(inputSnapshotId).toBe(sha256(canonicalJson(input)))
    }
    const touched = (await f.stores.events.read(state.runId, { types: ['artifact.touched'] })).at(-1)!.data as EventPayloads['artifact.touched']
    expect(touched.invocationId).toBe(events[1]!.invocation.invocationId)
    captures.push({ events, touched })
  }
  expect(captures.map((capture) => capture.events[1]!.recipe.recipeId)).toEqual(Array(3).fill(captures[0]!.events[1]!.recipe.recipeId))
  expect(captures.map((capture) => capture.touched.relation)).toEqual(['produced', 'reused', 'modified'])
  expect(captures[2]!.touched.previous?.version).toBe(1)
  const different = await f.start([{ ...nodes[0]!, prompt: '不同的静态任务' } as NodeDef])
  expect((await f.started(different.runId))[1]!.recipe.recipeId).not.toBe(captures[0]!.events[1]!.recipe.recipeId)
})

it('无失败 judge 不采集调用；rubric 每项单独记录检查点和调用，上游结果带 attempt', async () => {
  const f = await fixture(async () => ({ score: 100, pass: true, message: 'ok' }))
  const state = await f.start([
    script({ id: 'run', title: '运行', run: async () => ({ data: { failures: [] } }) }),
    judge({ id: 'judge', title: '判决', needs: ['run'], role: 'r1', target: 'run', routes: {} }),
    agent({ id: 'reader', title: '读取结果', needs: ['judge'], role: 'r1', prompt: (ctx) => JSON.stringify(ctx.resultOf('run')) }),
    gate({ id: 'gate', title: '门禁', needs: ['reader'], inputs: [{ path: 'spec.md' }], checks: ['one', 'two'].map((id) => ({ id, kind: 'rubric' as const, role: 'r1', rubric: id, threshold: 80 })) }),
  ])
  expect(state.status).toBe('succeeded')
  const calls = await f.started(state.runId)
  expect(calls.map((event) => event.invocation.nodeId)).toEqual(['reader', 'gate', 'gate'])
  expect(calls.slice(1).map((event) => event.invocation.gateCheckId)).toEqual(['one', 'two'])
  expect((calls[0]!.inputSnapshot as CapturedInputSnapshot).results[0]?.from).toEqual({ runId: state.runId, nodeId: 'run', attempt: 1 })
})

it('跳过技能同步仍记录实际目录 hash；冻结请求可重渲染，替换 Skill 后确定性重渲染', async () => {
  const f = await fixture()
  const source = join(f.root, 'skills', 'audit')
  const provided = join(f.root, '.agents', 'skills', 'audit')
  await mkdir(source, { recursive: true }); await mkdir(provided, { recursive: true })
  await writeFile(join(source, 'SKILL.md'), 'source new')
  await writeFile(join(provided, 'SKILL.md'), 'provided old')
  f.deps.profiles.r1!.skills = ['audit']
  const engine = createEngine({ ...f.deps, skillsDir: join(f.root, 'skills') })
  const state = await engine.start({ requirementId: f.requirementId, workflow: workflow([reviewer()]) })
  expect(state.status).toBe('succeeded')
  const { recipe, inputSnapshot } = (await f.started(state.runId))[0]!
  const snapshot = inputSnapshot as CapturedInputSnapshot
  expect(snapshot.skillsProvided?.[0]?.sha256).toBe(sha256(canonicalJson([{ path: 'SKILL.md', sha256: sha256('provided old') }])))
  expect(snapshot.skillsProvided?.[0]?.sha256).not.toBe(recipe.skills[0]!.sha256)
  expect(snapshot.skillUse.every((item) => item.loaded === 'unknown')).toBe(true)
  expect(snapshot.render.rendererVersion).toBe(RENDERER_VERSION)
  const params = JSON.parse((await getObject(f.stores, snapshot.render.params)).toString()) as PromptParams
  const template = (await getObject(f.stores, snapshot.render.template.object)).toString()
  const assets = await Promise.all(snapshot.render.assets.map(async (asset) => ({ ...asset, content: (await getObject(f.stores, asset.object)).toString() })))
  const original = renderRequest(template, params, assets)
  expect(original.prompt).toBe(f.calls[0]!.prompt)
  expect(original.systemAppend).toBe(f.calls[0]!.systemAppend)
  const replacement = assets.map((asset) => asset.id === params.skills[0] ? { ...asset, content: 'candidate skill' } : asset)
  const changed = renderRequest(template, params, replacement)
  expect(changed).toEqual(renderRequest(template, params, replacement))
  expect(changed.systemAppend).toContain('candidate skill')
  expect(changed.systemAppend).not.toBe(original.systemAppend)
  const duties = assets.map((asset) => asset.id === recipe.template.id ? { ...asset, content: canonicalJson({ ...JSON.parse(asset.content), checklist: ['替换后的职责'] }) } : asset)
  expect(renderRequest(template, params, duties).prompt).toContain('替换后的职责')
  expect(renderRequest(template, params, duties).prompt).not.toContain('验收标准有明确期望')
})

it('问题 key 跨轮沿用，作者回应关联调用；previous 逐 key 复查，缺项只记 not_checked', async () => {
  let round = 0
  const f = await fixture(async (req) => {
    if (req.env!.TAKT_ROLE === 'author') return { responses: [{ round, reviewer: 'r1', issueId: 'I1', action: 'fixed', note: '作者声称已修复' }] }
    round++
    if (round > 1) { expect(req.prompt).toContain('ISS-1'); expect(req.prompt).toContain('claimed_fixed') }
    return round < 3 ? { verdict: 'request_changes', summary: '未通过', issues: [{ id: 'I1', key: round === 1 ? '' : 'ISS-1', severity: 'major', description: '缺少期望结果' }], previous: round === 2 ? [{ key: 'ISS-1', status: 'still_open', note: '仍缺少' }] : [] }
      : { ...approve, previous: [{ key: 'ISS-1', status: 'resolved', note: '已验证期望' }] }
  })
  const state = await f.start([reviewer({ maxRounds: 3 })])
  expect(state.status).toBe('succeeded')
  const records = (await f.stores.events.read(state.runId, { types: ['review.result'] })).map((event) => (event.data as EventPayloads['review.result']).record)
  expect(records.slice(0, 2).map((record) => record.issues[0]!.key)).toEqual(['ISS-1', 'ISS-1'])
  expect(records[2]!.previous).toEqual([{ key: 'ISS-1', status: 'resolved', note: '已验证期望' }])
  expect((await f.started(state.runId)).map((event) => event.invocation.review?.part)).toEqual(['reviewer', 'author', 'reviewer', 'author', 'reviewer'])
  const authors = (await f.started(state.runId)).filter((event) => event.invocation.review?.part === 'author').map((event) => event.invocation.invocationId)
  const touches = (await f.stores.events.read(state.runId, { types: ['artifact.touched'] })).map((event) => event.data as EventPayloads['artifact.touched'])
  expect(touches.map((event) => event.invocationId)).toEqual(authors)
  const value = { issues: [], previous: undefined }
  assignIssues(value, [{ key: 'ISS-1', reviewer: 'r1', description: '未复查', status: 'still_open' }], 'r1', () => 'unused')
  expect(value.previous).toEqual([{ key: 'ISS-1', status: 'not_checked', note: '评审者未提供明确复查结论' }])
})

it('实际 dsh CLI 适配器不支持 model/effort 覆盖，requested 保留而 resolved 不冒充生效', async () => {
  const f = await fixture()
  const bin = join(f.root, 'dsh-fixture')
  await writeFile(bin, '#!/bin/sh\ncat >/dev/null\nprintf \'%s\\n\' \'{"type":"final","text":"OK"}\'\n')
  await chmod(bin, 0o755)
  const { createDshHarness } = await import('@taktflow/harness')
  f.deps.harnesses.dsh = createDshHarness({ bin })
  const state = await f.start([agent({ id: 'call', title: 'dsh', role: 'author', prompt: 'OK', harness: { harness: 'dsh', model: 'requested-model', effort: 'high' } })])
  expect(state.status).toBe('succeeded')
  const calls = await f.started(state.runId)
  expect(calls).toHaveLength(1)
  const invocation = calls[0]!.invocation as CapturedInvocation
  expect(invocation.requested).toMatchObject({ model: 'requested-model', effort: 'high' })
  expect(invocation.resolved).toEqual({ harness: 'dsh' })
  expect(invocation.effective).toEqual({ model: 'unsupported', effort: 'unsupported' })
  expect(invocation.replayNotes?.join('\n')).toContain('未生效')
})

it('对象正文和 harness.message 共用脱敏，缺少源码身份明确受限；健康探测不产生调用', async () => {
  const f = await fixture(async () => 'done')
  const secret = 'sk-captureSynthetic123456789'
  const state = await f.start([agent({ id: 'call', title: '脱敏', role: 'author', prompt: `request ${secret}` })])
  expect(state.status).toBe('succeeded')
  const { invocation, inputSnapshot } = (await f.started(state.runId))[0]!
  expect(inputSnapshot.redactions).toBeGreaterThan(0)
  expect(invocation.replay).toBe('limited')
  expect(invocation.replayNotes?.join('\n')).toContain('源码')
  expect((await getObject(f.stores, inputSnapshot.request.prompt)).toString()).not.toContain(secret)
  expect(JSON.stringify(await f.stores.events.read(state.runId))).not.toContain(secret)
  f.deps.harnesses.mock!.available = async () => ({ ok: false, reason: 'offline' })
  const offline = await f.start([agent({ id: 'call', title: '不可用', role: 'author', prompt: 'test' })])
  expect(await f.started(offline.runId)).toHaveLength(0)
})

it('加载入口的源码与依赖闭包在 start 冻结，恢复时不采纳新源码；角色支持 plugin AssetRef', async () => {
  const f = await fixture(async () => 'done')
  const { human } = await import('../dsl.js')
  const def = workflow([human({ id: 'approval', title: '确认', ask: '继续', form: 'approve' }), agent({ id: 'call', title: '调用', needs: ['approval'], role: 'author', prompt: 'task' })])
  const source = { id: 'workflows/main.ts', content: 'original workflow', dependencies: [{ id: 'workflows/hooks.ts', content: 'original hooks' }] }
  const role = { kind: 'plugin' as const, id: 'test-plugin@1#author', revision: '1', content: 'plugin role', sha256: sha256('plugin role') }
  const first = await createEngine(f.deps, { capture: { workflowSource: source, profiles: { author: role } } }).start({ requirementId: f.requirementId, workflow: def })
  expect(first.status).toBe('waiting_human')
  const [item] = await f.stores.attention.list({ pending: true })
  await f.stores.attention.answer(item!.requestId, { decision: 'approve', by: { type: 'human', id: 'test' } })
  source.content = 'changed workflow'; source.dependencies[0]!.content = 'changed hooks'
  const last = await createEngine(f.deps, { capture: { workflowSource: source, profiles: { author: role } } }).resume(first.runId, def)
  expect(last.status).toBe('succeeded')
  const { recipe, inputSnapshot } = (await f.started(last.runId))[0]!
  const frozen = (inputSnapshot as CapturedInputSnapshot).workflow!
  expect((await getObject(f.stores, frozen.object)).toString()).toBe('original workflow')
  expect((await getObject(f.stores, frozen.dependencies[0]!.object)).toString()).toBe('original hooks')
  expect(frozen.closureSha256).toBe(sha256(canonicalJson({ source: sha256('original workflow'), dependencies: [{ id: 'workflows/hooks.ts', sha256: sha256('original hooks') }] })))
  expect(recipe.profile).toEqual({ kind: 'plugin', id: role.id, revision: '1', sha256: role.sha256 })
})

it('并行普通节点仍使用真实事件序号；Skill 加载只在成功的可识别工具事件后确认', async () => {
  const f = await fixture()
  const dir = join(f.root, '.agents/skills/audit')
  await mkdir(dir, { recursive: true }); await writeFile(join(dir, 'SKILL.md'), 'audit skill')
  f.deps.harnesses.mock!.run = async (_req, emit): Promise<HarnessResult> => {
    emit({ type: 'started', model: 'reported-model', sessionId: 'session' })
    emit({ type: 'tool_call', tool: 'skill', input: '{"name":"audit"}', ok: true })
    emit({ type: 'message', role: 'assistant', text: 'done' })
    return { ok: true, finalText: 'done' }
  }
  const state = await f.start(Array.from({ length: 4 }, (_, i) => agent({ id: `n${i}`, title: '并行', role: 'author', prompt: 'task' })))
  expect(state.status).toBe('succeeded')
  const starts = await f.started(state.runId)
  expect(starts).toHaveLength(4)
  for (const event of starts) expect(event.invocation.invocationId).toBe(`${state.runId}:${event.seq}`)
  const finished = await f.stores.events.read(state.runId, { types: ['invocation.finished'] })
  for (const event of finished) expect(event.data).toMatchObject({ reported: { model: 'reported-model' }, skills: [{ asset: '.agents/skills/audit', loaded: 'confirmed' }] })
})

it('快照物化清单不匹配时拒绝发起调用，保留 scheduled 检查点', async () => {
  const f = await fixture()
  const state = await createEngine(f.deps, { capture: { materializeSnapshot: async () => ({ 'spec.md': 'bad' }) } }).start({ requirementId: f.requirementId, workflow: workflow([reviewer()]) })
  expect(state.status).toBe('failed')
  expect(state.nodes.review?.error).toContain('hash 不一致')
  expect(await f.started(state.runId)).toHaveLength(0)
  expect(await f.stores.events.read(state.runId, { types: ['checkpoint.scheduled'] })).toHaveLength(1)
})

it('fallback 失败候选已经写出的产物也归属于该调用', async () => {
  const f = await fixture(async (req) => { await writeFile(join(req.env!.TAKT_WORKSPACE!, 'out.md'), 'second'); return 'done' })
  f.deps.harnesses.first = { id: 'first', displayName: 'first', available: async () => ({ ok: true }), run: async (req) => {
    await writeFile(join(req.env!.TAKT_WORKSPACE!, 'out.md'), 'first')
    return { ok: false, finalText: '', error: '503 retry' }
  } }
  const state = await f.start([agent({ id: 'call', title: 'fallback', role: 'author', prompt: 'write', outputs: [{ path: 'out.md', kind: 'spec' }], harness: { harness: 'first', fallback: [{ harness: 'mock' }] } })])
  expect(state.status).toBe('succeeded')
  const calls = await f.started(state.runId)
  const touches = (await f.stores.events.read(state.runId, { types: ['artifact.touched'] })).map((event) => event.data as EventPayloads['artifact.touched'])
  expect(touches.map((event) => event.invocationId)).toEqual(calls.map((event) => event.invocation.invocationId))
  expect(touches.map((event) => event.relation)).toEqual(['produced', 'modified'])
  expect(touches[1]!.previous).toEqual(touches[0]!.ref)
})

it('review.result 与进度保存之间中断，恢复后复用已完成者且问题 key 不重分配', async () => {
  let firstCalls = 0
  let fail = true
  const f = await fixture(async (req) => {
    if (req.env!.TAKT_ROLE === 'r1') {
      firstCalls++
      return { ...approve, issues: [{ id: 'one', severity: 'minor', description: '说明缺失' }] }
    }
    if (fail) throw new Error('模拟第二位失败')
    return approve
  })
  const def = workflow([reviewer({ reviewers: [{ role: 'r1' }, { role: 'r2' }] })])
  const first = await createEngine(f.deps).start({ requirementId: f.requirementId, workflow: def })
  expect(first.status).toBe('failed')
  const file = join(f.stores.taktDir, 'runs', first.runId, 'engine.json')
  const progress = JSON.parse(await readFile(file, 'utf8'))
  progress.reviews.review.active.round.records = []
  await writeFile(file, JSON.stringify(progress))
  // 模拟进程崩溃时尚未写入 node.failed 的状态；持久 review.result 已存在。
  first.nodes.review!.status = 'running'
  first.status = 'running'
  await f.stores.runs.save(first)
  fail = false
  const last = await createEngine(f.deps).resume(first.runId, def)
  expect(last.status).toBe('succeeded')
  expect(firstCalls).toBe(1)
  const records = (await f.stores.events.read(last.runId, { types: ['review.result'] })).map((event) => (event.data as EventPayloads['review.result']).record)
  expect(records).toHaveLength(2)
  expect(records[0]!.issues[0]!.key).toBe('ISS-1')
})

it('只精确去重当前评审者引用的已有 key，不合并相同描述的新问题或跨评审者 key', () => {
  let next = 2
  const issue = { id: 'one', severity: 'minor' as const, description: '相同描述' }
  const current = [{ key: 'ISS-1', reviewer: 'r1', description: '相同描述', status: 'still_open' }]
  const value = { issues: [{ ...issue, key: 'ISS-1' }, { ...issue, id: 'two', key: 'ISS-1' }, { ...issue, id: 'three', key: '' }], previous: [] }
  assignIssues(value, current, 'r1', () => `ISS-${next++}`)
  expect(value.issues.map((issue) => issue.key)).toEqual(['ISS-1', 'ISS-2'])
  expect(() => assignIssues({ issues: [{ ...issue, key: 'ISS-1' }] }, current, 'r2', () => 'unused')).toThrow('其他评审者')
})
