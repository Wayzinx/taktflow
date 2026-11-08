import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import type { CheckpointDetail } from '../api.js'
import type { Actor, ArtifactRef, DefectAttribution, HarnessAdapter, MissAssessment, Observation, RunState } from '../types.js'
import { initProject } from '../store/project.js'
import { snapshotWorkflow } from '../store/snapshot.js'
import { sha256 } from '../util/hash.js'
import { QualityConflictError } from '../quality/index.js'
import { scorecards } from '../eval/scorecards.js'
import { getDefect } from './index.js'
import { assessCheckpoint, missVerdict, precheckCheckpoint, precheckDefectCheckpoints } from './checkpoint-assessment.js'
import { attributeDefectCheckpoints, decideCheckpointMiss } from './checkpoint-attribution.js'
import { createQualityDefect, readQualityDefect, updateQualityDefect } from './quality-service.js'
import { decideDefectMerge, suggestDefectMerges } from './merge-suggestions.js'

const roots: string[] = []
const human: Actor = { type: 'human', id: 'tester' }
const bot: Actor = { type: 'agent', role: 'auditor', harness: 'mock' }
const at = '2026-01-01T00:00:00.000Z'
const all: MissAssessment['conditions'] = { existed: true, materialProvided: true, inDuty: true, executed: true, notRaised: true }
const report = { title: '异常路径遗漏', description: '缺少边界校验', severity: 'major' as const, reason: '人工录入问题' }
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

function point(status: CheckpointDetail['status'] = 'done'): CheckpointDetail {
  return { id: 'run:review:1:1.1:qa', runId: 'run', nodeId: 'review', attempt: 1, role: 'reviewer', subject: 'qa',
    duties: ['核对边界校验'], scheduledAt: at, status, invocations: [], snapshot: { checkpointId: 'run:review:1:1.1:qa',
      dir: 'snapshots/run/point', duties: ['核对边界校验'], readOnly: 'none', createdAt: at,
      files: [{ path: 'target/spec/prd.md', role: 'target', source: 'artifact', ref: { workspace: 'REQ-1', path: 'spec/prd.md', version: 1 }, sha256: sha256('AC-1'), size: 4 }] } }
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'takt-m5-attribution-')); roots.push(root)
  const stores = await initProject(root)
  await stores.workspaces.createRequirement({ id: 'REQ-1', title: '测试归因' })
  return { root, stores, req: 'REQ-1', quality: stores.quality! }
}
async function seedPoint(f: Awaited<ReturnType<typeof fixture>>, p = point()) {
  const ref = await f.stores.workspaces.writeArtifact({ ref: { workspace: f.req, path: 'spec/prd.md' }, content: 'AC-1', kind: 'spec', author: human, reason: '构建冻结材料' })
  const run: RunState = { runId: p.runId, requirementId: f.req, workflowId: 'wf', workflowVersion: '1', status: 'succeeded', startedAt: at,
    args: {}, expansions: [], nodes: { [p.nodeId]: { id: p.nodeId, status: 'succeeded', attempts: 1, inputs: [ref], outputs: [] } } }
  await f.stores.runs.create(run, snapshotWorkflow({ id: 'wf', title: '归因', version: '1', stages: [], nodes: [{ id: p.nodeId, kind: 'review', title: '评审', target: ['spec/prd.md'], author: { role: 'dev' }, reviewers: [{ role: 'qa' }], maxRounds: 1, onExhausted: 'fail' }] }))
  await f.stores.events.append(p.runId, { type: 'node.started', nodeId: p.nodeId, actor: human, data: { attempt: 1 } })
  await f.stores.events.append(p.runId, { type: 'checkpoint.scheduled', nodeId: p.nodeId, actor: human, data: p })
  if (p.status !== 'scheduled') await f.stores.events.append(p.runId, { type: 'checkpoint.finished', nodeId: p.nodeId, actor: human, data: { id: p.id, status: p.status } })
  if (p.snapshot) {
    await f.stores.events.append(p.runId, { type: 'snapshot.created', nodeId: p.nodeId, actor: human, data: p.snapshot })
    for (const file of p.snapshot.files) {
      const path = join(f.stores.taktDir, p.snapshot.dir, 'files', file.path)
      await mkdir(dirname(path), { recursive: true }); await writeFile(path, 'AC-1')
    }
  }
  return ref
}
async function observation(f: Awaited<ReturnType<typeof fixture>>, id: string, patch: Partial<Observation> = {}) {
  const value: Observation = { id, requirementId: f.req, source: 'review', kind: 'finding', title: id, runId: 'run', nodeId: 'review',
    checkpointId: point().id, subject: 'ISS-1', at, by: human, ...patch }
  await f.quality.append([{ kind: 'observation.recorded', key: id, requirementId: f.req, data: value, actor: human }])
  return value
}

it.each([
  ['should_have_caught', all, false],
  ['caught_but_waived', { ...all, notRaised: false }, true],
  ['material_missing', { ...all, materialProvided: false }, false],
  ['not_executed', { ...all, executed: false }, false],
  ['out_of_scope', { ...all, inDuty: false }, false],
  ['undetermined', { materialProvided: true, executed: true }, false],
] as const)('五条件结论：%s', (verdict, conditions, waived) => {
  expect(missVerdict(conditions, waived)).toBe(verdict)
})
it.each(['existed', 'materialProvided', 'inDuty', 'executed', 'notRaised'] as const)('任一条件未知都不能推断漏检：%s', key => {
  const conditions = { ...all }; delete conditions[key]
  expect(missVerdict(conditions)).toBe('undetermined')
})
it.each(['scheduled', 'error', 'skipped'] as const)('检查点 %s 都是没执行完成', status => {
  expect(precheckCheckpoint(point(status), [])).toMatchObject({ verdict: 'not_executed', conditions: { executed: false } })
})
it('清单缺材料与快照缺失分开；同路径不同版本只证明材料提供', () => {
  const ref: ArtifactRef = { workspace: 'REQ-1', path: 'spec/prd.md', version: 9 }
  expect(precheckCheckpoint(point(), [ref])).toMatchObject({ verdict: 'undetermined', conditions: { materialProvided: true, executed: true } })
  expect(precheckCheckpoint(point(), [{ ...ref, path: 'missing.md' }]).verdict).toBe('material_missing')
  expect(precheckCheckpoint({ ...point(), snapshot: undefined }, [ref]).conditions.materialProvided).toBeUndefined()
  expect(precheckCheckpoint(point(), []).conditions.materialProvided).toBeUndefined()
  expect(() => precheckCheckpoint(point(), [{ ...ref, path: '../escape' }])).toThrow('非法')
})
it('auditor 不能覆盖预检，无明确职责不判 out_of_scope，无证据不采信', () => {
  const p = point('error'), assessment = precheckCheckpoint(p, [{ workspace: 'REQ-1', path: 'missing.md' }])
  expect(assessCheckpoint({ checkpoint: p, assessment, caughtButWaived: false }, { conditions: all, evidence: ['证据'] })).toMatchObject({ verdict: 'not_executed', conditions: { executed: false, materialProvided: false } })
  const unknown = { ...point(), duties: [], snapshot: { ...point().snapshot!, duties: [] } }
  expect(assessCheckpoint({ checkpoint: unknown, assessment: precheckCheckpoint(unknown, []), caughtButWaived: false }, { conditions: { inDuty: false }, evidence: ['猜测'] }).verdict).toBe('undetermined')
  expect(assessCheckpoint({ checkpoint: point(), assessment: precheckCheckpoint(point(), []), caughtButWaived: false }, { conditions: all, evidence: [] }).by).toBe('precheck')
})
it('创建可多选观察；外部录入同批追加 report；有效性和处理状态独立；并发版本冲突', async () => {
  const f = await fixture()
  await observation(f, 'obs-1'); await observation(f, 'obs-2')
  const defect = await createQualityDefect(f.stores, f.req, { ...report, observations: ['obs-1', 'obs-2', 'obs-1'] }, human)
  expect(defect).toMatchObject({ observations: ['obs-1', 'obs-2'], validity: 'unconfirmed', resolution: 'open', revision: 1 })
  expect(defect.observationsDetail).toHaveLength(2)
  const created = await Promise.all([createQualityDefect(f.stores, f.req, report, human), createQualityDefect(f.stores, f.req, report, human)])
  expect(new Set(created.map(item => item.id)).size).toBe(2)
  expect((await f.quality.observations()).filter(item => item.kind === 'report')).toHaveLength(2)
  const updates = await Promise.allSettled(['valid', 'not_defect'].map(validity => updateQualityDefect(f.stores, f.req, defect.id,
    { validity: validity as 'valid' | 'not_defect', baseRevision: 1, reason: '核验观察' }, human)))
  expect(updates.filter(item => item.status === 'fulfilled')).toHaveLength(1)
  expect((updates.find(item => item.status === 'rejected') as PromiseRejectedResult).reason).toBeInstanceOf(QualityConflictError)
  expect((await readQualityDefect(f.stores, f.req, defect.id)).resolution).toBe('open')
  await expect(createQualityDefect(f.stores, f.req, { ...report, observations: ['foreign'] }, human)).rejects.toThrow('不属于本需求')
  await expect(createQualityDefect(f.stores, f.req, { ...report, reason: '' }, human)).rejects.toThrow('reason')
  await expect(createQualityDefect(f.stores, f.req, report, bot)).rejects.toThrow('由人确认')
  const log = (await readFile(join(f.stores.taktDir, 'quality/log.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  for (const entry of log.filter(item => item.kind.startsWith('defect.'))) expect(entry.data.reason).toBeTruthy()
  await f.quality.rebuild()
  expect((await f.quality.observations()).find(item => item.id === 'obs-1')?.defects).toEqual([defect.id])
})
it('合并仅建议、人工接纳可撤销；并发决定不能覆盖；重算不恢复已否决建议', async () => {
  const f = await fixture()
  const a = await createQualityDefect(f.stores, f.req, report, human)
  await createQualityDefect(f.stores, f.req, report, human)
  const [suggestion] = await suggestDefectMerges(f.stores, f.req, bot, '检查重复线索')
  expect(suggestion?.status).toBe('suggested')
  const results = await Promise.allSettled(['accept', 'reject'].map(action => decideDefectMerge(f.stores, f.req, suggestion!.id,
    { action: action as 'accept' | 'reject', baseRevision: a.revision!, reason: '对照根因' }, human)))
  expect(results.filter(item => item.status === 'fulfilled')).toHaveLength(1)
  const current = await readQualityDefect(f.stores, f.req, a.id)
  expect(await decideDefectMerge(f.stores, f.req, suggestion!.id, { action: 'undo', baseRevision: current.revision!, reason: '重新核对' }, human)).toMatchObject({ status: 'undone' })
  const latest = await readQualityDefect(f.stores, f.req, a.id)
  await decideDefectMerge(f.stores, f.req, suggestion!.id, { action: 'reject', baseRevision: latest.revision!, reason: '根因不同' }, human)
  expect((await suggestDefectMerges(f.stores, f.req, bot, '再次分析'))[0]?.status).toBe('rejected')
  expect((await f.quality.defects(f.req)).map(item => item.validity)).toEqual(['unconfirmed', 'unconfirmed'])
  await f.quality.rebuild()
  expect((await f.quality.mergeSuggestions(f.req))[0]?.status).toBe('rejected')
  await expect(decideDefectMerge(f.stores, f.req, suggestion!.id, { action: 'undo', baseRevision: 1, reason: 'x' }, bot)).rejects.toThrow('由人确认')
})
it('同一问题键限于 run/node；相同用例不自动建议合并', async () => {
  const f = await fixture()
  await observation(f, 'a', { checkpointId: 'cp-a', subject: 'TC-1', source: 'judge' })
  await observation(f, 'b', { checkpointId: 'cp-b', subject: 'TC-1', source: 'judge' })
  await observation(f, 'c', { checkpointId: 'cp-c', runId: 'other', subject: 'ISS-1' })
  await observation(f, 'd', { checkpointId: 'cp-d', subject: 'ISS-1' })
  await observation(f, 'e', { checkpointId: 'cp-e', subject: 'ISS-1' })
  for (const [i, id] of ['a', 'b', 'c', 'd', 'e'].entries()) await createQualityDefect(f.stores, f.req, { ...report, title: ['崩溃', '超时', '乱码', '丢包', '拒绝'][i]!, observations: [id] }, human)
  const suggestions = await suggestDefectMerges(f.stores, f.req, bot, '核对来源')
  expect(suggestions).toHaveLength(1)
  expect(suggestions[0]?.defects).toEqual(['D-4', 'D-5'])
})
it('同一问题的提出后放行可确定，其他节点 ISS-1 不构成放行证据', async () => {
  const f = await fixture(); await seedPoint(f)
  await observation(f, 'raised')
  await observation(f, 'unrelated', { nodeId: 'other', kind: 'waived' })
  const defect = await createQualityDefect(f.stores, f.req, { ...report, observations: ['raised'] }, human)
  expect((await precheckDefectCheckpoints(f.stores, defect))[0]?.caughtButWaived).toBe(false)
  await observation(f, 'waived', { kind: 'waived', checkpointId: undefined })
  const [evidence] = await precheckDefectCheckpoints(f.stores, defect)
  expect(assessCheckpoint(evidence!).verdict).toBe('caught_but_waived')
})
it('人工逐点改判进入日志，自动结果不能覆盖；新提案仍可记录其他点', async () => {
  const f = await fixture(); const ref = await seedPoint(f)
  await observation(f, 'report', { source: 'external', kind: 'report', artifacts: [ref] })
  const defect = await createQualityDefect(f.stores, f.req, { ...report, observations: ['report'] }, human)
  const confirmed = await decideCheckpointMiss(f.stores, f.req, defect.id, point().id, { verdict: 'should_have_caught', conditions: all, note: '逐项核对冻结版和输出' }, human,
    { baseRevision: defect.revision!, reason: '人工确认漏检' })
  expect(confirmed.attribution?.checkpoints?.[0]).toMatchObject({ by: 'human', confirmed: { by: human }, verdict: 'should_have_caught' })
  const candidate: DefectAttribution = { ...confirmed.attribution!, by: bot, confirmed: undefined,
    checkpoints: [{ ...confirmed.attribution!.checkpoints![0]!, verdict: 'undetermined', by: 'auditor', confirmed: undefined }] }
  await f.quality.append([{ kind: 'attribution.recorded', key: 'auto-recheck', requirementId: f.req, data: { ...candidate, reason: '再次自动检查' }, actor: bot }],
    { baseRevision: { defectId: defect.id, revision: confirmed.revision! } })
  await f.quality.rebuild()
  expect((await readQualityDefect(f.stores, f.req, defect.id)).attribution?.checkpoints?.[0]?.verdict).toBe('should_have_caught')
  await expect(decideCheckpointMiss(f.stores, f.req, defect.id, point().id, { verdict: 'material_missing', conditions: { materialProvided: false } }, human,
    { baseRevision: confirmed.revision!, reason: '错误改判' })).rejects.toThrow('确定性预检不一致')
  await expect(decideCheckpointMiss(f.stores, f.req, defect.id, point().id, { verdict: 'undetermined' }, human,
    { baseRevision: 1, reason: '陈旧页面' })).rejects.toBeInstanceOf(QualityConflictError)
})
it('auditor prompt 含冻结材料、职责、输出，候选不能伪造人工确认或覆盖确定性条件', async () => {
  const f = await fixture(); const ref = await seedPoint(f)
  await observation(f, 'external', { kind: 'report', source: 'external', artifacts: [ref] })
  const defect = await createQualityDefect(f.stores, f.req, { ...report, observations: ['external'] }, human)
  await f.stores.events.append('run', { type: 'review.result', nodeId: 'review', actor: human, data: { checkpointId: point().id, revision: 1, round: 1,
    record: { reviewer: 'qa', round: 1, verdict: 'pass', issues: [], summary: '没有发现边界遗漏', artifacts: [ref], checkpointId: point().id, at } } })
  let prompt = ''
  const adapter: HarnessAdapter = { id: 'mock', displayName: 'mock', capabilities: { structuredOutput: true, readOnly: true }, available: async () => ({ ok: true }),
    run: async request => {
      prompt = request.prompt
      const structured = { introducedAt: { origin: 'unknown', evidence: ['检查冻结材料'] }, missedBy: [], confidence: 0.8, suggestions: [],
        confirmed: { by: human, at }, checkpoints: [{ checkpointId: point().id, conditions: { ...all, executed: false }, evidence: ['AC-1 边界未处理，职责要求覆盖，输出未提出'], by: 'human', confirmed: { by: human, at } }] }
      return { ok: true, finalText: JSON.stringify(structured), structured }
    } }
  const result = await attributeDefectCheckpoints({ stores: f.stores, knowledge: [], harnesses: { mock: adapter }, profiles: {
    auditor: { role: 'auditor', title: '审计', description: '', instructions: '', skills: [], writeScope: [], harness: { harness: 'mock' } },
  } }, f.req, defect.id, { baseRevision: defect.revision!, reason: '运行独立审计' })
  expect(prompt).toContain('AC-1'); expect(prompt).toContain('核对边界校验'); expect(prompt).toContain('没有发现边界遗漏')
  expect(result.attribution?.confirmed).toBeUndefined()
  expect(result.attribution?.checkpoints?.[0]).toMatchObject({ by: 'auditor', verdict: 'undetermined', conditions: { executed: true } })
  expect(result.attribution?.checkpoints?.[0]?.conditions.existed).toBeUndefined()
  expect(result.attribution?.checkpoints?.[0]?.confirmed).toBeUndefined()
})
it('检出率按已确认有效 finding 与人工确认漏检检查点统计，忽略原始门禁失败、未确认问题和 M3 漏检原因', async () => {
  const f = await fixture(); const ref = await seedPoint(f)
  await observation(f, 'finding', { artifacts: [ref] }); await observation(f, 'finding-duplicate', { artifacts: [ref] })
  const caught = await createQualityDefect(f.stores, f.req, { ...report, observations: ['finding', 'finding-duplicate'] }, human)
  expect((await scorecards(f.stores, { by: 'node' }))[0]?.detection).toEqual({ caught: 0, missed: 0, rate: undefined })
  await updateQualityDefect(f.stores, f.req, caught.id, { validity: 'valid', baseRevision: caught.revision!, reason: '确认有效' }, human)
  const missedPoint = { ...point(), id: 'run:review:1:1.1:qa2', subject: 'qa2' }
  await f.stores.events.append('run', { type: 'checkpoint.scheduled', nodeId: 'review', actor: human, data: missedPoint })
  await f.stores.events.append('run', { type: 'checkpoint.finished', nodeId: 'review', actor: human, data: { id: missedPoint.id, status: 'done' } })
  await f.stores.events.append('run', { type: 'snapshot.created', nodeId: 'review', actor: human, data: { ...point().snapshot!, checkpointId: missedPoint.id } })
  await observation(f, 'report-miss', { kind: 'report', source: 'external', artifacts: [ref] })
  let missed = await createQualityDefect(f.stores, f.req, { ...report, observations: ['report-miss'] }, human)
  missed = await updateQualityDefect(f.stores, f.req, missed.id, { validity: 'valid', baseRevision: missed.revision!, reason: '确认有效' }, human)
  await decideCheckpointMiss(f.stores, f.req, missed.id, missedPoint.id, { verdict: 'should_have_caught', conditions: all }, human,
    { baseRevision: missed.revision!, reason: '核对五条件' })
  await f.stores.events.append('run', { type: 'gate.result', nodeId: 'review', actor: human, data: { pass: false, checks: [{ id: 'broken', pass: false, status: 'error', message: '启动失败' }] } })
  expect((await scorecards(f.stores, { by: 'node' }))[0]?.detection).toEqual({ caught: 1, missed: 1, rate: 0.5 })
})
it('M3 归因原样从质量读模型展示，不把旧 missedBy 转成五条件', async () => {
  const f = await fixture()
  const defect = await createQualityDefect(f.stores, f.req, report, human)
  const legacy: DefectAttribution = { defectId: defect.id, introducedAt: { origin: 'unknown', evidence: ['M3'] },
    missedBy: [{ nodeId: 'review', reason: 'reviewed_but_missed', evidence: ['历史记录'] }], confidence: 0.5, suggestions: [], precheck: {}, by: bot, at }
  await f.quality.append([{ kind: 'attribution.recorded', key: 'legacy', requirementId: f.req, data: { ...legacy, reason: '兼容旧归因' }, actor: bot }],
    { baseRevision: { defectId: defect.id, revision: defect.revision! } })
  expect((await getDefect(f.stores, f.req, defect.id)).attribution).toEqual(legacy)
  expect((await readQualityDefect(f.stores, f.req, defect.id)).attribution?.checkpoints).toBeUndefined()
})
it('多评审者按调用配方归属，节点与共享技能按检查点去重，旧配方不丢失', async () => {
  const f = await fixture(); await seedPoint(f)
  for (const [index, recipeKey] of ['old', 'other', 'new'].entries()) {
    const role = recipeKey === 'other' ? 'qa2' : 'qa'
    await f.stores.events.append('run', { type: 'node.recipe', nodeId: 'review', actor: bot, data: { workflowId: 'wf', workflowVersion: '1', nodeId: 'review', kind: 'review',
      role, recipeKey, skills: [{ name: 'review', hash: 'shared' }] } })
    await f.stores.events.append('run', { type: 'invocation.started', nodeId: 'review', actor: bot, data: { id: `inv-${index}`, nodeId: 'review', attempt: 1,
      checkpointId: `cp-${recipeKey}`, role: 'reviewer', agentRole: role, fallbackIndex: 0, recipeKey, harness: 'mock', model: {}, effort: {}, skills: [], at } })
  }
  await observation(f, 'caught-old', { checkpointId: 'cp-old' }); await observation(f, 'caught-other', { checkpointId: 'cp-other' })
  const defect = await createQualityDefect(f.stores, f.req, { ...report, observations: ['caught-old', 'caught-other'] }, human)
  await updateQualityDefect(f.stores, f.req, defect.id, { validity: 'valid', baseRevision: 1, reason: '确认两个检查点都提出了问题' }, human)
  const cards = await scorecards(f.stores, { by: 'recipe' })
  expect(Object.fromEntries(cards.map(card => [card.key.recipeKey, card.detection?.caught]))).toEqual({ old: 1, other: 1, new: 0 })
  expect((await scorecards(f.stores, { by: 'node' }))[0]?.detection?.caught).toBe(2)
  expect((await scorecards(f.stores, { by: 'skill' }))[0]?.detection?.caught).toBe(2)
})
it('人工确认仍需五条件齐全，已提出的问题不能确认成漏检', async () => {
  const f = await fixture(); const ref = await seedPoint(f)
  await observation(f, 'raised', { artifacts: [ref] })
  const defect = await createQualityDefect(f.stores, f.req, { ...report, observations: ['raised'] }, human)
  await expect(decideCheckpointMiss(f.stores, f.req, defect.id, point().id, { verdict: 'should_have_caught', conditions: all }, human,
    { baseRevision: 1, reason: '不能忽略 finding' })).rejects.toThrow('不满足所需条件')
  await expect(decideCheckpointMiss(f.stores, f.req, defect.id, point().id, { verdict: 'should_have_caught' }, human,
    { baseRevision: 1, reason: '不能补全未知条件' })).rejects.toThrow('不满足所需条件')
})
