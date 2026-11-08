import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { agent, gate, review, script, defineWorkflow } from '../dsl.js'
import { initProject, openProject } from '../store/project.js'
import type { AgentProfile, HarnessAdapter, HarnessRequest, HarnessEvent, HarnessResult, NodeDef, ReviewRecord, ReviewIssueEntry, EventPayloads } from '../types.js'
import { createEngine } from './index.js'
import { checkpointId } from './checkpoints.js'
import { nodeQuality } from '../insights/node-quality.js'
import { reviewDetail } from '../insights/reviews.js'
import { setReviewDisposition } from '../review/dispositions.js'
import { recordIssues, recordResponses } from './issues.js'
import { codeMaterials } from './snapshots.js'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
const approved = { verdict: 'approve', summary: '通过', issues: [] }
const workflow = (nodes: NodeDef[]) => defineWorkflow({ id: 'capture', title: '采集验证', version: '1', stages: [], nodes })
async function fixture(handler: (req: HarnessRequest, event: (event: HarnessEvent) => void) => Promise<HarnessResult>) {
  const root = await mkdtemp(join(tmpdir(), 'takt-capture-')); roots.push(root)
  const stores = await initProject(root)
  const requirementId = (await stores.workspaces.createRequirement({ title: '采集验证' })).id
  const profiles = Object.fromEntries(['author', 'r1', 'r2', 'r3'].map(role => [role, { role, title: role, description: '', instructions: role, skills: [], writeScope: ['requirements/**'], harness: { harness: 'mock' } } satisfies AgentProfile]))
  const mock: HarnessAdapter = { id: 'mock', displayName: 'mock', capabilities: { structuredOutput: true }, available: async () => ({ ok: true }), run: handler }
  return { root, stores, requirementId, deps: { stores, profiles, harnesses: { mock }, knowledge: [] } }
}
const writer = () => script({ id: 'write', title: '产物', outputs: [{ path: 'spec.md', kind: 'spec' }, { path: 'ref.md', kind: 'spec' }], run: async ctx => {
  await writeFile(join(ctx.workspaceDir, 'spec.md'), '冻结目标')
  await writeFile(join(ctx.workspaceDir, 'ref.md'), '冻结依据')
} })
const reviewNode = (extra: Partial<Parameters<typeof review>[0]> = {}) => review({ id: 'review', title: '评审', needs: ['write'], target: ['spec.md'], references: ['ref.md'],
  author: { role: 'author' }, reviewers: [{ role: 'r1', checklist: ['完整性', '边界'] }, { role: 'r2' }, { role: 'r3' }], maxRounds: 1, onExhausted: 'fail', ...extra })

it('检查点 ID 与逐评审者落盘：失败保留已完成记录，后续 skipped，换实例恢复不重跑', async () => {
  const calls: string[] = []
  let fail = true
  const f = await fixture(async req => {
    calls.push(req.env!.TAKT_ROLE!)
    if (req.env!.TAKT_ROLE === 'r2' && fail) throw new Error('评审服务故障')
    return { ok: true, finalText: '', structured: approved }
  })
  const wf = workflow([writer(), reviewNode()])
  const first = await createEngine(f.deps).start({ requirementId: f.requirementId, workflow: wf })
  expect(first.status).toBe('failed')
  expect(calls).toEqual(['r1', 'r2'])
  let quality = await nodeQuality(f.stores, first.runId, 'review')
  expect(quality.checkpoints.map(point => point.status)).toEqual(['done', 'error', 'skipped'])
  expect(quality.checkpoints[0]!.id).toBe(checkpointId(first.runId, 'review', 1, 1, 1, 'r1'))
  expect((await reviewDetail(f.stores, first.runId, 'review'))?.facets?.coverage).toBe('partial')
  const artifact = await f.stores.workspaces.readArtifact({ workspace: f.requirementId, path: 'reviews/review/r1-round-1/r1.json' })
  expect(JSON.parse(artifact!.toString()).checkpointId).toBe(quality.checkpoints[0]!.id)
  // 模拟现有重试入口把失败节点重新排队；新引擎从磁盘恢复进度。
  first.status = 'running'; first.nodes.review!.status = 'pending'
  await f.stores.runs.save(first)
  fail = false
  const resumed = await createEngine({ ...f.deps, stores: await openProject(f.root) }).resume(first.runId, wf)
  expect(resumed.status).toBe('succeeded')
  expect(calls).toEqual(['r1', 'r2', 'r2', 'r3'])
  quality = await nodeQuality(f.stores, first.runId, 'review')
  expect(quality.checkpoints.filter(point => point.status === 'done')).toHaveLength(3)
  expect((await reviewDetail(f.stores, first.runId, 'review'))?.facets?.coverage).toBe('full')
})

it('快照包含 target/reference 的指定版本、职责和只读权限，prompt 不注入当前存放区内容', async () => {
  const requests: HarnessRequest[] = []
  const f = await fixture(async req => { requests.push(req); return { ok: true, finalText: '', structured: approved } })
  const state = await createEngine(f.deps).start({ requirementId: f.requirementId, workflow: workflow([writer(), reviewNode({ reviewers: [{ role: 'r1', checklist: ['完整性'] }] })]) })
  expect(state.status).toBe('succeeded')
  const [point] = (await nodeQuality(f.stores, state.runId, 'review')).checkpoints
  expect(point?.snapshot).toMatchObject({ duties: ['完整性'], readOnly: 'permissions' })
  expect(point?.snapshot?.files.map(file => [file.role, file.ref?.version])).toEqual([['target', 1], ['reference', 1]])
  const target = join(f.stores.taktDir, point!.snapshot!.dir, 'files', 'target/spec.md')
  await writeFile(join(f.stores.workspaces.dir(f.requirementId), 'spec.md'), '后来改写')
  expect(await readFile(target, 'utf8')).toBe('冻结目标')
  expect((await stat(target)).mode & 0o222).toBe(0)
  expect(requests[0]?.prompt).toContain(target)
  expect(requests[0]?.prompt).not.toContain('公共存放区：')
  expect(requests[0]?.prompt).not.toContain('冻结目标')
  expect(requests[0]?.readOnly).toBe(true)
  expect(requests[0]?.sandbox?.spec.mounts).toContainEqual({ source: join(f.stores.taktDir, point!.snapshot!.dir), target: join(f.stores.taktDir, point!.snapshot!.dir), mode: 'ro' })
})

it.each([false, undefined, true])('fallback 两次调用与三层模型值，能力 applied=%s', async applied => {
  const f = await fixture(async () => ({ ok: false, finalText: '', error: '503 unavailable' }))
  f.stores.config.models = { alias: { id: 'resolved-model', contextWindow: 8192 } }
  f.deps.profiles.author!.skills = ['check']
  const skill = join(f.stores.paths.skills, 'check')
  await mkdir(skill, { recursive: true }); await writeFile(join(skill, 'SKILL.md'), '检查版本')
  let request: HarnessRequest | undefined
  const second: HarnessAdapter = { id: 'second', displayName: 'second', capabilities: { modelOverride: applied, effortOverride: false }, available: async () => ({ ok: true }), run: async (req, event) => {
    request = req
    event({ type: 'started', model: 'actual-model', effort: 'actual-effort', skills: ['check'] })
    event({ type: 'tool_call', tool: 'Read', input: 'file', callId: 'c1', phase: 'start' })
    event({ type: 'tool_call', tool: 'Read', input: 'file', callId: 'c1', phase: 'end', output: 'ok' })
    await writeFile(join(req.env!.TAKT_WORKSPACE!, 'result.md'), '实际产物')
    return { ok: true, finalText: '完成' }
  } }
  const state = await createEngine({ ...f.deps, skillsDir: f.stores.paths.skills, harnesses: { ...f.deps.harnesses, second } }).start({ requirementId: f.requirementId, workflow: workflow([
    agent({ id: 'produce', title: '产出', role: 'author', prompt: '完成', outputs: [{ path: 'result.md', kind: 'spec' }], harness: { harness: 'mock', model: 'first', fallback: [{ harness: 'second', model: 'alias', effort: 'high' }] } }),
  ]) })
  expect(state.status).toBe('succeeded')
  const quality = await nodeQuality(f.stores, state.runId, 'produce')
  expect(quality.invocations.map(invocation => invocation.outcome)).toEqual(['error', 'ok'])
  expect(quality.invocations[1]).toMatchObject({ role: 'producer', fallbackIndex: 1, model: { requested: 'alias', resolved: 'resolved-model', reported: 'actual-model' }, effort: { requested: 'high', reported: 'actual-effort', applied: false } })
  expect(quality.invocations[1]!.model.applied).toBe(applied)
  expect(quality.invocations[1]!.skills[0]).toMatchObject({ name: 'check', providedHash: expect.any(String), confirmed: 'yes' })
  expect(quality.invocations[0]!.skills[0]?.confirmed).toBe('unknown')
  expect(request?.model).toBe('resolved-model')
  const events = await f.stores.events.read(state.runId)
  expect(events.filter(event => event.type.startsWith('harness.')).every(event => event.actor.type === 'agent' && !!event.actor.invocationId)).toBe(true)
  expect(events.find(event => event.type === 'harness.started')?.data).toMatchObject({ contextWindow: 8192, skills: ['check'] })
  expect(events.filter(event => event.type === 'harness.tool_call').at(-1)?.data).toMatchObject({ phase: 'end', callId: 'c1', durationMs: expect.any(Number) })
  const output = (await f.stores.workspaces.listArtifacts(f.requirementId)).find(artifact => artifact.path === 'result.md')
  expect(output?.versions[0]?.producedBy?.invocationId).toBe(quality.invocations[1]?.id)
})

it('不可用候选不产生 invocation', async () => {
  const f = await fixture(async () => ({ ok: true, finalText: '完成' }))
  const unavailable: HarnessAdapter = { id: 'off', displayName: 'off', available: async () => ({ ok: false }), run: async () => { throw new Error('不应运行') } }
  const state = await createEngine({ ...f.deps, harnesses: { ...f.deps.harnesses, off: unavailable } }).start({ requirementId: f.requirementId, workflow: workflow([
    agent({ id: 'produce', title: '产出', role: 'author', prompt: '完成', harness: { harness: 'off', fallback: [{ harness: 'mock' }] } }),
  ]) })
  expect((await nodeQuality(f.stores, state.runId, 'produce')).invocations.map(invocation => invocation.fallbackIndex)).toEqual([1])
})

it('问题键拒绝自造、按引用延续；作者声称已修和评审确认修复不同', async () => {
  const events: Array<{ type: string; data: unknown }> = []
  const host = { timestamp: () => '2026-11-08T00:00:00Z', emit: async (type: string, data: unknown) => { events.push({ type, data }) } }
  const ledger: ReviewIssueEntry[] = []
  const record = (issues: ReviewRecord['issues'], previous?: ReviewRecord['previous']): ReviewRecord => ({ round: 1, reviewer: 'r1', verdict: 'request_changes', summary: '', issues, artifacts: [], at: host.timestamp(), previous })
  const first = record([{ id: 'a', key: 'ISS-999', severity: 'major', description: '缺少边界' }])
  await recordIssues(host, 'review', ledger, first, 1)
  expect(first.issues[0]?.key).toBe('ISS-1')
  expect(events.some(event => event.type === 'log')).toBe(true)
  await recordResponses(host, 'review', ledger, [first], [{ round: 1, reviewer: 'r1', issueId: 'a', action: 'fixed', note: '已补' }], 1)
  expect(ledger[0]?.status).toBe('claimed_fixed')
  await recordIssues(host, 'review', ledger, record([]), 2)
  expect(ledger[0]?.status).toBe('claimed_fixed')
  expect(ledger[0]?.history.at(-1)?.action).toBe('not_checked')
  await recordIssues(host, 'review', ledger, record([], [{ key: 'ISS-1', status: 'resolved', note: '已核验' }]), 2)
  expect(ledger[0]?.status).toBe('verified_fixed')
  await recordIssues(host, 'review', ledger, record([{ id: 'b', key: 'ISS-1', severity: 'major', description: '再次出现' }]), 3)
  expect(ledger).toHaveLength(1)
  expect(ledger[0]?.history.at(-1)?.action).toBe('reopened')
})

it('问题台账可回读，人工 resolved 记 waived 而不是 verified_fixed', async () => {
  const f = await fixture(async () => ({ ok: true, finalText: '', structured: { verdict: 'request_changes', summary: '修改', issues: [{ id: 'a', severity: 'major', title: '边界', description: '缺少边界' }] } }))
  const state = await createEngine(f.deps).start({ requirementId: f.requirementId, workflow: workflow([writer(), reviewNode({ reviewers: [{ role: 'r1' }] })]) })
  await setReviewDisposition(f.stores, state.runId, 'review', { groupKey: 'ISS-1', state: 'resolved', reason: '接受剩余风险', by: { type: 'human', id: 'owner' } })
  expect((await nodeQuality(f.stores, state.runId, 'review')).issues?.[0]?.status).toBe('waived')
  expect((await reviewDetail(f.stores, state.runId, 'review'))?.facets?.open.major).toBe(0)
})

it('门禁三态区分非零退出、抛错、超时和 rubric 解析失败', async () => {
  const f = await fixture(async () => ({ ok: true, finalText: '不是结构化结果' }))
  const state = await createEngine(f.deps).start({ requirementId: f.requirementId, workflow: workflow([
    gate({ id: 'gate', title: '门禁', timeoutMs: 200, checks: [
      { id: 'pass', kind: 'command', run: 'exit 0' }, { id: 'fail', kind: 'command', run: 'exit 2' },
      { id: 'throw', kind: 'function', fn: async () => { throw new Error('检查崩溃') } },
      { id: 'timeout', kind: 'command', run: 'sleep 10' }, { id: 'rubric', kind: 'rubric', role: 'r1', rubric: '1. 正确\n2. 完整', threshold: 80 },
    ] }),
  ]) })
  const events = await f.stores.events.read(state.runId, { types: ['gate.result'] })
  const checks = (events[0]!.data as EventPayloads['gate.result']).checks
  expect(checks.map(check => check.status)).toEqual(['pass', 'fail', 'error', 'error', 'error'])
  expect(checks.every(check => !!check.checkpointId)).toBe(true)
  const quality = await nodeQuality(f.stores, state.runId, 'gate')
  expect(quality.checkpoints.at(-1)).toMatchObject({ duties: ['正确', '完整'], status: 'error', gate: { pass: false, status: 'error' } })
})

it('代码快照从当时 HEAD 读取 diff 和改动文件，不混入后来的工作树内容', async () => {
  const root = await mkdtemp(join(tmpdir(), 'takt-code-snapshot-')); roots.push(root)
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim()
  git('init', '-b', 'main'); git('config', 'user.name', 'test'); git('config', 'user.email', 'test@localhost')
  await writeFile(join(root, 'a.txt'), 'before'); git('add', '.'); git('commit', '-m', 'base')
  const base = git('rev-parse', 'HEAD')
  await writeFile(join(root, 'a.txt'), 'committed'); git('add', '.'); git('commit', '-m', 'change')
  await writeFile(join(root, 'a.txt'), 'dirty')
  const materials = await codeMaterials(root, 'app', base)
  expect(materials.find(file => file.source === 'file')?.content.toString()).toBe('committed')
  expect(materials.find(file => file.source === 'diff')?.content.toString()).toContain('+committed')
  expect(materials.every(file => file.commit === git('rev-parse', 'HEAD'))).toBe(true)
})

it('旧运行没有采集事件时返回空数组', async () => {
  const f = await fixture(async () => ({ ok: true, finalText: '' }))
  const state = await createEngine(f.deps).start({ requirementId: f.requirementId, workflow: workflow([script({ id: 'old', title: '旧节点', run: async () => {} })]) })
  expect(await nodeQuality(f.stores, state.runId, 'old')).toEqual({ checkpoints: [], invocations: [], issues: [] })
})

it('作者声称已修后只有 explicit previous.resolved 才关闭问题，读模型同步验证', async () => {
  let rounds = 0
  const f = await fixture(async req => {
    if (req.env!.TAKT_ROLE === 'author') return { ok: true, finalText: '', structured: { responses: [{ round: 1, reviewer: 'r1', issueId: 'a', action: 'fixed', note: '已补' }] } }
    return { ok: true, finalText: '', structured: ++rounds === 1
      ? { verdict: 'request_changes', summary: '补充', issues: [{ id: 'a', severity: 'major', description: '缺少边界' }] }
      : { ...approved, previous: [{ key: 'ISS-1', status: 'resolved', note: '已核验' }] } }
  })
  const state = await createEngine(f.deps).start({ requirementId: f.requirementId, workflow: workflow([writer(), reviewNode({ reviewers: [{ role: 'r1' }], maxRounds: 2 })]) })
  expect(state.status).toBe('succeeded')
  const quality = await nodeQuality(f.stores, state.runId, 'review')
  expect(quality.issues?.[0]?.history.map(item => item.action)).toEqual(['raised', 'claimed_fixed', 'verified_fixed'])
  expect(quality.checkpoints.map(point => point.role)).toEqual(['reviewer', 'author', 'reviewer'])
  expect(quality.invocations.map(invocation => invocation.role)).toEqual(['reviewer', 'author', 'reviewer'])
  const recipes = await f.stores.events.read(state.runId, { nodeId: 'review', types: ['node.recipe'] })
  for (const invocation of quality.invocations) expect(recipes.some(event => {
    const recipe = event.data as EventPayloads['node.recipe']
    return recipe.recipeKey === invocation.recipeKey && recipe.role === invocation.agentRole
  })).toBe(true)
  expect((await reviewDetail(f.stores, state.runId, 'review'))?.facets?.open.major).toBe(0)
})

it('acceptance 的追溯材料解析失败记 error，缺少覆盖记 fail', async () => {
  const f = await fixture(async () => ({ ok: true, finalText: '' }))
  const clean = await createEngine(f.deps).start({ requirementId: f.requirementId, workflow: workflow([
    gate({ id: 'gate', title: '校验', checks: [{ kind: 'acceptance', id: 'ac', title: '逐条校验验收标准' }] }),
  ]) })
  expect((await nodeQuality(f.stores, clean.runId, 'gate')).checkpoints[0]?.gate?.status).toBe('fail')
  await f.stores.workspaces.writeArtifact({ ref: { workspace: f.requirementId, path: 'cases/broken.json' }, content: 'invalid json', kind: 'case', author: { type: 'system', id: 'fixture' }, reason: '模拟损坏材料' })
  const broken = await createEngine(f.deps).start({ requirementId: f.requirementId, workflow: workflow([
    gate({ id: 'gate', title: '校验', checks: [{ kind: 'acceptance', id: 'ac' }] }),
  ]) })
  expect((await nodeQuality(f.stores, broken.runId, 'gate')).checkpoints[0]?.gate).toMatchObject({ pass: false, status: 'error' })
})
