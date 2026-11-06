import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProjectStores } from '../interfaces.js'
import type { ArtifactRef, EventPayloads, EventType } from '../types.js'
import type { AttributionView, CheckpointRef, DefectView, Observation, Recipe } from '../quality.js'
import type { CapturedInputSnapshot } from '../engine/capture-types.js'
import type { QualityEventInput } from '../store/quality-store.js'
import { initProject } from '../store/project.js'
import { putObject } from '../store/objects.js'
import { canonicalJson, sha256 } from '../util/hash.js'
import { attributionCandidates } from './attribution.js'
import { escapeAnalysis } from './escape-analysis.js'
import { qualitySummary } from './quality-summary.js'
import { recipe, recipeDiff } from './recipe.js'
import { retrieveText, unifiedDiff } from './quality-text.js'

const human = { type: 'human', id: 'owner', via: 'cli' } as const
const agent = { type: 'agent', role: 'author', harness: 'test' } as const
const system = { type: 'system', id: 'test' } as const
let stores: ProjectStores, dir: string, clock: number, counter: number
const now = () => new Date().toISOString()
function tick() { vi.setSystemTime(clock += 1000) }

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  clock = Date.parse('2026-11-01T00:00:00Z'); counter = 0; vi.setSystemTime(clock)
  dir = await mkdtemp(join(tmpdir(), 'takt-attribution-'))
  stores = await initProject(dir)
  await stores.workspaces.createRequirement({ id: 'REQ-1', title: '支付' })
  await run('run-1')
})
afterEach(async () => { vi.useRealTimers(); await rm(dir, { recursive: true, force: true }) })

async function run(runId: string, requirementId = 'REQ-1') {
  await stores.runs.create({ runId, requirementId, workflowId: 'flow', workflowVersion: '1', status: 'succeeded',
    startedAt: now(), args: {}, nodes: {}, expansions: [] },
  { id: 'flow', title: 'flow', version: '1', stages: [{ id: 'design', title: '系分' }, { id: 'test', title: '测试' }],
    nodes: [{ id: 'author', kind: 'agent', title: 'author', needs: [], stage: 'design' },
      { id: 'review', kind: 'review', title: 'review', needs: ['author'], stage: 'test' }] })
}
async function emit<T extends EventType>(type: T, data: EventPayloads[T], nodeId = 'author', runId = 'run-1') {
  tick()
  return stores.events.append(runId, { type, data, nodeId, actor: system })
}
async function quality(event: QualityEventInput) {
  tick()
  return stores.quality!.append([event], { idempotencyKeys: [event.type === 'observation.recorded' ? event.data.id : `q-${++counter}`] })
}
async function artifact(content: string, path = 'design.md', derivedFrom: ArtifactRef[] = [], manual = false) {
  tick()
  return stores.workspaces.writeArtifact({ ref: { workspace: 'REQ-1', path }, kind: 'design', content,
    author: manual ? human : agent, reason: 'test', derivedFrom, producedBy: manual ? undefined : { runId: 'run-1', nodeId: 'author' } })
}
const asset = (id: string, content = id) => ({ kind: 'inline' as const, id, sha256: sha256(content) })
function makeRecipe(): Recipe {
  return { recipeId: 'recipe-1', role: 'author', profile: asset('profile'), template: asset('template'), skills: [asset('skill')], harness: 'test' }
}
async function invocation(inputs: ArtifactRef[] = [], options: { nodeId?: string; runId?: string; attempt?: number; checkpoint?: CheckpointRef;
  results?: CapturedInputSnapshot['results']; recipe?: Recipe; assets?: CapturedInputSnapshot['render']['assets'] } = {}) {
  const runId = options.runId ?? 'run-1', nodeId = options.nodeId ?? 'author'
  const invocationId = `${runId}:${(await stores.events.read(runId)).length + 1}`
  const object = await putObject(stores, '{}')
  const inputSnapshot = { inputSnapshotId: `input-${invocationId}`, request: { prompt: object }, inputs: await Promise.all(inputs.map(async (ref) => {
    const content = (await stores.workspaces.readArtifact(ref))!
    return { ref, sha256: sha256(content), object: await putObject(stores, content), role: 'input' as const }
  })), results: options.results ?? [], cwdLayout: { root: dir, paths: {} }, redactions: 0,
  render: { rendererVersion: '1', template: { kind: 'node-prompt' as const, object }, params: object, assets: options.assets ?? [],
    exec: { adapter: 'test', adapterVersion: '1', tools: [], permissions: 'read', env: [] } } }
  const event = await emit('invocation.started', { recipe: options.recipe ?? makeRecipe(), inputSnapshot,
    invocation: { invocationId, runId, nodeId, attempt: options.attempt ?? 1, checkpointId: options.checkpoint?.checkpointId,
      review: options.checkpoint ? { round: options.checkpoint.round!, part: 'reviewer', reviewer: options.checkpoint.reviewer } : undefined,
      fallbackIndex: 0, recipeId: (options.recipe ?? makeRecipe()).recipeId, inputSnapshotId: inputSnapshot.inputSnapshotId, resolved: { harness: 'test' }, replay: 'full' } }, nodeId, runId)
  return event.data
}
async function touch(ref: ArtifactRef, invocationId?: string, relation: EventPayloads['artifact.touched']['relation'] = 'produced', previous?: ArtifactRef) {
  await emit('artifact.touched', { ref, invocationId, nodeId: 'author', attempt: 1, relation, previous })
}
async function checkpoint(refs: ArtifactRef[], options: { checklist?: string[]; completed?: boolean; error?: boolean; key?: string; previousKey?: string;
  reviewer?: string; attempt?: number; nodeId?: string; runId?: string } = {}) {
  const nodeId = options.nodeId ?? 'review', runId = options.runId ?? 'run-1', reviewer = options.reviewer ?? 'reviewer'
  const dutyText = canonicalJson({ checklist: options.checklist ?? ['支付金额必须正确'], focus: '支付', rubric: '' })
  const dutyHash = await putObject(stores, dutyText)
  const cp: CheckpointRef = { checkpointId: `${runId}:${nodeId}:${options.attempt ?? 1}:${++counter}:${reviewer}`, runId, nodeId,
    attempt: options.attempt ?? 1, round: counter, reviewer, status: 'scheduled', duty: { kind: 'inline', id: 'duty', sha256: dutyHash },
    materials: await Promise.all(refs.map(async (ref) => ({ ref, sha256: sha256((await stores.workspaces.readArtifact(ref))!), role: 'target' as const }))) }
  await emit('checkpoint.scheduled', cp, nodeId, runId)
  if (options.completed === false) return cp
  const call = await invocation(refs, { checkpoint: cp, nodeId, runId, attempt: cp.attempt, assets: [{ ...cp.duty!, object: dutyHash }] })
  cp.invocationId = call.invocation.invocationId
  await emit('invocation.finished', { invocationId: cp.invocationId, outcome: { status: options.error ? 'error' : 'ok' } }, nodeId, runId)
  if (!options.error) await emit('review.result', { checkpointId: cp.checkpointId, invocationId: cp.invocationId,
    record: { round: cp.round!, reviewer, verdict: options.key ? 'request_changes' : 'approve', summary: 'review', artifacts: refs, at: now(),
      issues: options.key ? [{ id: '1', key: options.key, severity: 'major', description: '支付金额错误' }] : [],
      previous: options.previousKey ? [{ key: options.previousKey, status: 'still_open' }] : [] }, references: [] }, nodeId, runId)
  return cp
}
async function observe(ref?: ArtifactRef, cp?: CheckpointRef, kind: Observation['kind'] = 'found', issueKey = 'ISS-1'): Promise<Observation> {
  tick()
  const observation: Observation = { id: `observation-${++counter}`, source: cp ? 'review' : 'external', kind, issueKey,
    requirementId: 'REQ-1', runId: cp?.runId ?? 'run-1', nodeId: cp?.nodeId ?? 'review', attempt: cp?.attempt ?? 1,
    round: cp?.round, checkpointId: cp?.checkpointId, invocationId: cp?.invocationId,
    subject: { artifact: ref }, text: '支付金额错误', evidence: [], at: now() }
  await quality({ type: 'observation.recorded', actor: system, data: observation })
  return observation
}
async function defect(observations: Observation[], options: { id?: string; validity?: DefectView['validity']; requirementId?: string } = {}) {
  const id = options.id ?? `DEF-${++counter}`
  await quality({ type: 'defect.created', actor: human, data: { defect: { id, requirementId: options.requirementId ?? 'REQ-1', title: '支付金额错误',
    severity: 'major', observations: observations.map((item) => item.id), validity: options.validity ?? 'valid', resolution: 'open', createdBy: human, createdAt: now() } } })
  return id
}
async function confirm(id: string, ref?: ArtifactRef, patch: Partial<AttributionView> = {}) {
  const current = (await stores.quality!.defect(id))!
  await quality({ type: 'attribution.recorded', actor: human, data: { defectId: id, baseRevision: current.revision,
    attribution: { status: 'confirmed', category: 'design', injected: ref ? { artifact: ref, diffEvidence: '上一版金额正确，此版错误' } : undefined,
      escapes: [], candidates: [], method: 'human', rationale: '已核对差异', evidence: [], by: human, at: now(), ...patch } } })
}

describe('attributionCandidates', () => {
  it('沿历史版本、人工版本、reused、derivedFrom 与结构化结果追溯，不把复用者当唯一作者', async () => {
    const spec = await artifact('AC-001 金额必须正确', 'spec.md')
    const source = await invocation([spec], { nodeId: 'source', attempt: 2 })
    const resultObject = await putObject(stores, '{"amount":"支付金额错误"}')
    const producer = await invocation([spec], { results: [{ from: { runId: 'run-1', nodeId: 'source', attempt: 2 }, object: resultObject }] })
    const first = await artifact('AC-001 TC-OLD 支付金额错误\n', 'design.md', [spec]); await touch(first, producer.invocation.invocationId)
    const manual = await artifact('AC-002 TC-MANUAL 支付金额错误，改错别字\n', 'design.md', [], true)
    const reused = await invocation([spec]); await touch(manual, reused.invocation.invocationId, 'reused', manual)
    const review = await checkpoint([manual], { key: 'ISS-1' })
    const id = await defect([await observe(manual, review)])
    await artifact('AC-999 TC-CURRENT 已经修复', 'design.md')
    const future = await invocation([]); await touch(manual, future.invocation.invocationId, 'reused', manual)
    const before = await stores.quality!.read()
    const view = await attributionCandidates(stores, id)
    expect(view.status).toBe('candidate'); expect(view.judgment).toBe(false)
    const old = view.candidates.find((item) => item.artifact.path === 'design.md' && item.artifact.version === 1)!
    const edited = view.candidates.find((item) => item.artifact.path === 'design.md' && item.artifact.version === 2)!
    expect(old.traceIds).toEqual(['AC-001', 'TC-OLD'])
    expect(edited.traceIds).toEqual(['AC-002', 'TC-MANUAL']); expect(edited.human).toBe(true)
    expect(edited.touches.map((item) => item.relation)).toEqual(['reused'])
    expect(edited.diff.text).toContain('-AC-001 TC-OLD'); expect(edited.diff.text).toContain('+AC-002 TC-MANUAL')
    expect(old.touches[0]?.call?.inputSnapshot.results?.[0]?.object).toBe(resultObject)
    expect(view.results[0]?.calls.map((call) => call.invocation.invocationId)).toEqual([source.invocation.invocationId])
    expect(view.results[0]?.content).toContain('支付金额错误')
    expect(view.edges.map((edge) => edge.relation)).toEqual(expect.arrayContaining(['previous', 'derivedFrom', 'input', 'result']))
    expect(view.candidates).toHaveLength(3)
    expect(edited.retrieval.current).toMatchObject({ kind: 'text_retrieval', judgment: false })
    expect(await stores.quality!.read()).toEqual(before)
  })

  it('观察没有 subject 时从检查点 target 找到版本，references 通过输入追溯', async () => {
    const ref = await artifact('TC-ONE 支付金额错误')
    const cp = await checkpoint([ref], { key: 'ISS-1' })
    const id = await defect([await observe(undefined, cp)])
    expect((await attributionCandidates(stores, id)).roots).toEqual([ref])
  })

  it('没有版本或正文时保留缺失证据，不读取最新版或伪造 traceIds', async () => {
    await artifact('AC-999 当前文档')
    const id = await defect([await observe({ workspace: 'REQ-1', path: 'design.md' })])
    const view = await attributionCandidates(stores, id)
    expect(view.status).toBe('unknown'); expect(view.candidates[0]?.traceIds).toEqual([])
    expect(view.candidates[0]?.diff.available).toBe(false)
  })

  it('同版本输入与 previous 自环不导致无限递归', async () => {
    const ref = await artifact('支付金额错误')
    const call = await invocation([ref]); await touch(ref, call.invocation.invocationId, 'reused', ref)
    const id = await defect([await observe(ref)])
    expect((await attributionCandidates(stores, id)).candidates).toHaveLength(1)
  })

  it('结果依赖跨运行保留准确 attempt，不混入同节点的后续尝试', async () => {
    const spec = await artifact('AC-100 支付金额约束', 'spec.md')
    await run('upstream')
    const source = await invocation([spec], { runId: 'upstream', nodeId: 'source', attempt: 1 })
    await invocation([], { runId: 'upstream', nodeId: 'source', attempt: 2 })
    const object = await putObject(stores, '{"金额":-1}')
    const call = await invocation([], { results: [{ from: { runId: 'upstream', nodeId: 'source', attempt: 1 }, object }] })
    const ref = await artifact('支付金额错误'); await touch(ref, call.invocation.invocationId)
    const id = await defect([await observe(ref)])
    const view = await attributionCandidates(stores, id)
    expect(view.results[0]?.calls.map((item) => item.invocation.invocationId)).toEqual([source.invocation.invocationId])
    expect(view.candidates.map((item) => item.artifact.path)).toContain('spec.md')
  })

  it('历史正文丢失显示不可用，篡改正文则拒绝提供证据', async () => {
    const ref = await artifact('支付金额错误')
    const id = await defect([await observe(ref)])
    const object = join(stores.taktDir, 'objects', sha256('支付金额错误'))
    await rm(object)
    const view = await attributionCandidates(stores, id)
    expect(view.candidates[0]?.diff.available).toBe(false)
    expect(view.candidates[0]?.traceIds).toEqual([])
    await writeFile(object, '篡改正文')
    await expect(attributionCandidates(stores, id)).rejects.toThrow(/hash|哈希/)
  })

  it('无关联观察返回 unknown，缺陷不存在与缺质量存储时报上下文错误', async () => {
    const id = await defect([])
    expect((await attributionCandidates(stores, id)).status).toBe('unknown')
    await expect(attributionCandidates(stores, 'missing')).rejects.toThrow('缺陷不存在')
    await expect(attributionCandidates({ ...stores, quality: undefined }, id)).rejects.toThrow('未提供质量存储')
  })
})

describe('escapeAnalysis', () => {
  it('按区间列出所有检查点，分别建议未暴露、未执行、错误、候选、无职责未知；含发现点，排除区间外', async () => {
    const other = await artifact('无关内容', 'other.md')
    await checkpoint([other])
    const ref = await artifact('支付金额错误')
    const hidden = await checkpoint([other])
    const skipped = await checkpoint([ref], { completed: false })
    const error = await checkpoint([ref], { error: true })
    const missed = await checkpoint([ref])
    const noDuty = await checkpoint([ref], { checklist: [] })
    const found = await checkpoint([ref], { key: 'ISS-1' })
    const id = await defect([await observe(ref, found)])
    await checkpoint([ref])
    await confirm(id, ref)
    const log = await stores.quality!.read()
    const view = await escapeAnalysis(stores, id)
    expect(view.checkpoints.map((item) => [item.checkpointId, item.verdict])).toEqual([
      [hidden.checkpointId, 'not_exposed'], [skipped.checkpointId, 'not_executed'], [error.checkpointId, 'not_executed'],
      [missed.checkpointId, 'should_have_caught'], [noDuty.checkpointId, 'undetermined'],
      [found.checkpointId, 'undetermined'],
    ])
    const candidate = view.checkpoints[3]!
    expect(candidate.candidate).toBe(true); expect(candidate.suggested).toBe(true)
    expect(candidate.conditions.map((item) => [item.condition, item.status])).toEqual([
      ['defect_present', 'supported'], ['materials_visible', 'supported'], ['duty_matches', 'unknown'], ['completed', 'supported'], ['not_raised', 'supported'],
    ])
    expect(candidate.conditions.every((condition) => condition.evidence.length)).toBe(true)
    expect(view.checkpoints[1]?.invocationId).toBeUndefined()
    expect(await stores.quality!.read()).toEqual(log)
  })

  it.each(['declined', 'overridden'] as const)('同 key 被 %s 只有 valid 缺陷才建议 caught_but_overridden', async (kind) => {
    const ref = await artifact('支付金额错误')
    const cp = await checkpoint([ref], { key: 'ISS-1' })
    const raised = await observe(ref, cp)
    const declined = await observe(ref, cp, kind)
    const found = await observe(ref)
    const id = await defect([raised, declined, found])
    await confirm(id, ref)
    const view = await escapeAnalysis(stores, id)
    expect(view.checkpoints[0]?.verdict).toBe('caught_but_overridden')
    const unconfirmed = await defect([raised, declined, found], { validity: 'unconfirmed' })
    await confirm(unconfirmed, ref)
    expect((await escapeAnalysis(stores, unconfirmed)).checkpoints[0]?.verdict).toBe('undetermined')
    expect(raised.issueKey).toBe(found.issueKey)
  })

  it('不跨评审者、attempt、运行用相同 ISS key 关联拒绝记录', async () => {
    const ref = await artifact('支付金额错误')
    const miss = await checkpoint([ref], { reviewer: 'one' })
    const other = await checkpoint([ref], { reviewer: 'two', key: 'ISS-1' })
    const rejected = await observe(ref, other, 'declined')
    const next = await checkpoint([ref], { reviewer: 'one', attempt: 2, key: 'ISS-1' })
    const rejectedNext = await observe(ref, next, 'declined')
    await run('run-2')
    const remote = await checkpoint([ref], { runId: 'run-2', reviewer: 'one', key: 'ISS-1' })
    const rejectedRemote = await observe(ref, remote, 'declined')
    const found = await observe(ref)
    const id = await defect([rejected, rejectedNext, rejectedRemote, found]); await confirm(id, ref)
    const view = await escapeAnalysis(stores, id)
    expect(view.checkpoints.find((item) => item.checkpointId === miss.checkpointId)?.verdict).toBe('should_have_caught')
    expect(view.checkpoints.filter((item) => item.verdict === 'caught_but_overridden')).toHaveLength(3)
  })

  it('后续 still_open 也算提出问题，已提出但未拒绝不能算漏拦', async () => {
    const ref = await artifact('支付金额错误')
    const cp = await checkpoint([ref], { previousKey: 'ISS-1' })
    const linked = await observe(ref, cp, 'ignored')
    const id = await defect([linked, await observe(ref)]); await confirm(id, ref)
    const suggestion = (await escapeAnalysis(stores, id)).checkpoints[0]!
    expect(suggestion.verdict).toBe('undetermined')
    expect(suggestion.conditions.find((item) => item.condition === 'not_raised')?.status).toBe('not_supported')
  })

  it('相关产物旧版尚未引入错误，不因关键词相同判为漏拦候选', async () => {
    const old = await artifact('支付金额正确')
    const ref = await artifact('支付金额错误')
    const cp = await checkpoint([old])
    const id = await defect([await observe(ref)]); await confirm(id, ref)
    const suggestion = (await escapeAnalysis(stores, id)).checkpoints.find((item) => item.checkpointId === cp.checkpointId)!
    expect(suggestion.verdict).toBe('undetermined')
    expect(suggestion.conditions[0]?.status).toBe('not_supported')
  })

  it('后续版本的文本命中仍需人工确认缺陷存在和职责对应', async () => {
    const ref = await artifact('支付金额错误')
    const later = await artifact('支付金额错误，后续文案')
    await checkpoint([later])
    const id = await defect([await observe(later)]); await confirm(id, ref)
    const suggestion = (await escapeAnalysis(stores, id)).checkpoints[0]!
    expect(suggestion.verdict).toBe('should_have_caught')
    expect(suggestion.conditions[0]?.status).toBe('unknown')
    expect(suggestion.retrieval[0]?.result.hits.length).toBeGreaterThan(0)
  })

  it('没有确认引入点时不自动猜测；显式 injected 只生成预览', async () => {
    const ref = await artifact('支付金额错误'); await checkpoint([ref])
    const id = await defect([await observe(ref)])
    expect((await escapeAnalysis(stores, id)).status).toBe('undetermined')
    const preview = await escapeAnalysis(stores, id, { artifact: ref, diffEvidence: '待确认' })
    expect(preview.checkpoints[0]?.candidate).toBe(true)
    expect(preview.checkpoints[0]?.conditions[0]?.status).toBe('unknown')
    expect((await stores.quality!.defect(id))?.attribution).toBeUndefined()
  })

  it('在发现后才完成的检查点仍是 not_executed，缺少调度记录的历史结果也保留', async () => {
    const ref = await artifact('支付金额错误')
    const pending = await checkpoint([ref], { completed: false })
    await emit('review.result', { checkpointId: 'legacy', record: { reviewer: 'legacy', round: 1, artifacts: [ref], issues: [], summary: 'old', verdict: 'approve', at: now() }, references: [] }, 'review')
    const found = await observe(ref)
    await emit('review.result', { checkpointId: pending.checkpointId, record: { reviewer: 'reviewer', round: pending.round!, artifacts: [ref], issues: [], summary: 'late', verdict: 'approve', at: now() }, references: [] }, 'review')
    const id = await defect([found]); await confirm(id, ref)
    const view = await escapeAnalysis(stores, id)
    expect(view.checkpoints.map((item) => [item.checkpointId, item.verdict])).toEqual([[pending.checkpointId, 'not_executed'], ['legacy', 'undetermined']])
  })

  it('关键词不匹配不推断 out_of_scope；缺少冻结职责正文时只能 undetermined', async () => {
    const ref = await artifact('支付金额错误')
    const cp = await checkpoint([ref], { checklist: ['校对排版格式'] })
    const id = await defect([await observe(ref)]); await confirm(id, ref)
    let suggestion = (await escapeAnalysis(stores, id)).checkpoints[0]!
    expect(suggestion.verdict).toBe('should_have_caught')
    expect(suggestion.conditions[2]?.status).toBe('unknown')
    await rm(join(stores.taktDir, 'objects', cp.duty!.sha256))
    suggestion = (await escapeAnalysis(stores, id)).checkpoints[0]!
    expect(suggestion.verdict).toBe('undetermined')
  })

  it('只认提出问题之后的拒绝记录，不认其他 key 的拒绝', async () => {
    const ref = await artifact('支付金额错误')
    const cp = await checkpoint([ref], { key: 'ISS-1' })
    const ignored = await observe(ref, cp, 'ignored')
    await observe(ref, cp, 'declined', 'ISS-2')
    const early: Observation = { ...ignored, id: 'early-declined', kind: 'declined', at: '2026-10-01T00:00:00.000Z' }
    await quality({ type: 'observation.recorded', actor: system, data: early })
    const id = await defect([ignored, await observe(ref)]); await confirm(id, ref)
    expect((await escapeAnalysis(stores, id)).checkpoints[0]?.verdict).toBe('undetermined')
  })

  it('rubric 门禁有成功调用与 gate.result 时不误报未执行；无 checklist 仍无法判断漏拦', async () => {
    const ref = await artifact('支付金额错误')
    const dutyHash = await putObject(stores, '{"rubric":"支付金额正确"}')
    const cp: CheckpointRef = { checkpointId: 'run-1:gate:1:0:amount', runId: 'run-1', nodeId: 'gate', attempt: 1, checkId: 'amount',
      status: 'scheduled', duty: { kind: 'inline', id: 'rubric', sha256: dutyHash },
      materials: [{ ref, sha256: sha256('支付金额错误'), role: 'target' }] }
    await emit('checkpoint.scheduled', cp, 'gate')
    const call = await invocation([ref], { checkpoint: cp, nodeId: 'gate', assets: [{ ...cp.duty!, object: dutyHash }] })
    await emit('invocation.finished', { invocationId: call.invocation.invocationId, outcome: { status: 'ok' } }, 'gate')
    await emit('gate.result', { pass: true, checks: [{ id: 'amount', pass: true, score: 1 }] }, 'gate')
    const id = await defect([await observe(ref)]); await confirm(id, ref)
    const suggestion = (await escapeAnalysis(stores, id)).checkpoints[0]!
    expect(suggestion.verdict).toBe('undetermined')
    expect(suggestion.conditions[3]?.status).toBe('supported')
  })
})

describe('qualitySummary', () => {
  it('只统计确认有效样本的阶段、拦截与漏拦，缺失阶段 unknown 单列并按缺陷检查点去重', async () => {
    const call = await invocation()
    const ref = await artifact('支付金额错误'); await touch(ref, call.invocation.invocationId)
    const missed = await checkpoint([ref])
    const found = await checkpoint([ref], { key: 'ISS-1' })
    const observation = await observe(ref, found)
    const id = await defect([observation, observation]); await confirm(id, ref, { injected: { artifact: ref, invocationId: call.invocation.invocationId, diffEvidence: 'diff' },
      escapes: [missed, missed].map((cp) => ({ checkpointId: cp.checkpointId, runId: cp.runId, nodeId: cp.nodeId, attempt: cp.attempt, verdict: 'should_have_caught', rationale: '人已核对', evidence: ['diff'] })) })
    const unknown = await defect([]); await confirm(unknown)
    const disputed = await defect([observation]); await confirm(disputed, ref, { status: 'disputed' })
    await defect([observation], { validity: 'unconfirmed' })
    const duplicate = await defect([observation], { validity: 'duplicate' }); await confirm(duplicate, ref)
    const view = await qualitySummary(stores)
    expect(view.defects.total).toBe(5)
    expect(view.defects.byValidity).toMatchObject({ valid: 3, unconfirmed: 1, duplicate: 1 })
    expect(view.defects.byResolution.open).toBe(5)
    expect(view.defects.byCategory).toMatchObject({ design: 3, unknown: 2 })
    expect(view.stages).toEqual({ confirmed: 2, unknown: 1, counts: [
      { injected: 'design', discovered: 'test', count: 1 }, { injected: 'unknown', discovered: 'unknown', count: 1 },
    ] })
    expect(view.checkpoints).toMatchObject({ confirmedDefects: 2, intercepted: 1, missed: 1, caughtButOverridden: 0 })
    expect(view.counting.checkpoints).toContain('defectId + checkpointId')
  })

  it('被人工放行单列，不充当成功拦截；按 requirement 筛选', async () => {
    const ref = await artifact('支付金额错误')
    const cp = await checkpoint([ref], { key: 'ISS-1' })
    const obs = await observe(ref, cp)
    const id = await defect([obs]); await confirm(id, ref, { escapes: [{ checkpointId: cp.checkpointId, runId: cp.runId,
      nodeId: cp.nodeId, attempt: cp.attempt, verdict: 'caught_but_overridden', rationale: '接受风险', evidence: [] }] })
    await stores.workspaces.createRequirement({ id: 'REQ-2', title: 'other' })
    await defect([], { requirementId: 'REQ-2' })
    expect((await qualitySummary(stores)).defects.total).toBe(2)
    const view = await qualitySummary(stores, 'REQ-1')
    expect(view.defects.total).toBe(1)
    expect(view.checkpoints).toMatchObject({ intercepted: 0, missed: 0, caughtButOverridden: 1 })
    expect((await qualitySummary(stores, 'missing')).defects.total).toBe(0)
  })

  it('确认同 key 的后续观察可关联前轮拦截，同一检查点多个观察仍只计一次', async () => {
    const ref = await artifact('支付金额错误')
    const first = await checkpoint([ref], { key: 'ISS-1' })
    const next = await checkpoint([ref], { previousKey: 'ISS-1' })
    const obs = await observe(ref, next, 'still_open')
    const id = await defect([obs, await observe(ref, next, 'still_open')]); await confirm(id, ref)
    const view = await qualitySummary(stores)
    expect(view.checkpoints.intercepted).toBe(2)
    expect(view.checkpoints.counts.map((item) => item.checkpointId)).toEqual([first.checkpointId, next.checkpointId].sort())
  })
})

describe('recipe / recipeDiff / text evidence', () => {
  it('从指定 invocation 读冻结配方，不把运行或配方 ID 当调用身份', async () => {
    const first = await invocation([], { recipe: { ...makeRecipe(), model: 'model-old' } })
    await invocation([], { recipe: { ...makeRecipe(), model: 'model-new' } })
    expect((await recipe(stores, first.invocation.invocationId))?.model).toBe('model-old')
    expect(await recipe(stores, 'run-1:999')).toBeUndefined()
    expect(await recipe(stores, 'recipe-1')).toBeUndefined()
  })

  it('字段级比较包含 AssetRef 的 kind/id/hash/revision，忽略对象键顺序', () => {
    const a = makeRecipe(), b = structuredClone(a)
    b.profile = { sha256: a.profile.sha256, id: a.profile.id, kind: a.profile.kind }
    expect(recipeDiff(a, b)).toEqual([])
    b.profile.revision = 'v2'; b.skills[0]!.sha256 = 'changed'; b.template.id = 'other'; b.model = 'new'
    expect(recipeDiff(a, b).map((item) => item.field)).toEqual(['profile', 'skills', 'template', 'model'])
    expect(recipeDiff(a, b).find((item) => item.field === 'model')).toEqual({ field: 'model', before: null, after: 'new' })
    b.profile.kind = 'plugin'
    expect(recipeDiff(a, b)[0]?.after).toMatchObject({ kind: 'plugin', revision: 'v2' })
  })

  it('统一 diff 给出上下文、行号、新建与无末尾换行，并明确截断', () => {
    expect(unifiedDiff('one\ntwo\nthree\n', 'one\nchanged\nthree\n', 'v1', 'v2').text)
      .toBe('--- v1\n+++ v2\n@@ -1,3 +1,3 @@\n one\n-two\n+changed\n three\n')
    expect(unifiedDiff('', 'created', '/dev/null', 'v1').text).toContain('@@ -0,0 +1,1 @@\n+created\n\\ No newline at end of file')
    const limited = unifiedDiff('a'.repeat(1000), 'b'.repeat(1000), 'a', 'b', 100)
    expect(limited.truncated).toBe(true); expect(limited.text.length).toBe(100)
    expect(unifiedDiff(undefined, 'text', 'a', 'b').available).toBe(false)
    expect(unifiedDiff('same', 'same', 'a', 'b').text).toBe('')
  })

  it('中文与英文段落检索返回行号和相似度，不输出判断', () => {
    const result = retrieveText('无关\n\n支付金额错误\namount mismatch\n\nother', '支付金额 amount')
    expect(result).toMatchObject({ kind: 'text_retrieval', judgment: false })
    expect(result.hits[0]).toMatchObject({ startLine: 3, endLine: 4, text: '支付金额错误\namount mismatch' })
    expect(retrieveText('nothing', '支付')).toMatchObject({ hits: [] })
  })
})
