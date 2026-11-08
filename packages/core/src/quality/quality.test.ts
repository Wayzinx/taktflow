import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type { Defect, DefectAttribution, EvalCase, EvalRun, EventPayloads, Observation, QualityLogEntry, RunState } from '../types.js'
import { initProject, openProject } from '../store/project.js'
import { getDefect, reportDefect } from '../defects/index.js'
import { evalRoot, targetSlug } from '../eval/storage.js'
import { QualityConflictError } from './index.js'
import { buildViews } from './models.js'
import { chainHash } from './chain.js'
import type { QualityInput } from './migration.js'

const human = { type: 'human', id: 'tester' } as const
const system = { type: 'system', id: 'quality-test' } as const
const agent = { type: 'agent', role: 'auditor', harness: 'mock', invocationId: 'inv-1' } as const
const roots: string[] = []
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))) })

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'takt-quality-')); roots.push(root)
  const stores = await initProject(root)
  const requirement = await stores.workspaces.createRequirement({ title: '质量日志' })
  const quality = stores.quality!
  const run: RunState = { runId: 'run-quality', requirementId: requirement.id, workflowId: 'test', workflowVersion: '1',
    status: 'succeeded', startedAt: new Date().toISOString(), args: {}, nodes: {}, expansions: [] }
  await stores.runs.create(run, { id: 'test', title: '测试', version: '1', nodes: [], stages: [] })
  const dir = join(stores.taktDir, 'quality')
  const log = async () => (await readFile(join(dir, 'log.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as QualityLogEntry)
  const defect: Defect = { id: 'D-1', requirementId: requirement.id, title: '字段缺失', description: '输出漏掉字段', severity: 'major',
    foundAt: run.startedAt, reportedBy: human, status: 'open' }
  const create: QualityInput = { kind: 'defect.created', key: 'create', requirementId: requirement.id, actor: human, data: { ...defect, reason: '录入问题' } }
  return { stores, quality, requirement, run, root, dir, log, defect, create }
}

function attribution(id = 'D-1'): DefectAttribution {
  return { defectId: id, introducedAt: { origin: 'unknown', evidence: ['待核实'] }, missedBy: [], confidence: 0.5,
    suggestions: [], precheck: {}, by: agent, at: new Date().toISOString() }
}

it('挂接质量存储，重复 sync 幂等，观察三态与来源身份独立，不生成缺陷', async () => {
  const { stores, quality, run, requirement, log } = await setup()
  const issue: EventPayloads['review.issue'] = { key: 'ISS-1', action: 'raised', revision: 0, round: 1, by: 'reviewer', checkpointId: 'cp-1',
    entry: { key: 'ISS-1', title: '问题', severity: 'major', status: 'open', raisedBy: 'reviewer', first: { revision: 0, round: 1 }, last: { revision: 0, round: 1 } } }
  for (const action of ['raised', 'claimed_fixed', 'verified_fixed', 'dismissed', 'waived', 'not_checked'] as const) {
    await stores.events.append(run.runId, { type: 'review.issue', nodeId: 'review', actor: agent, data: { ...issue, action } })
  }
  await stores.events.append(run.runId, { type: 'judge.verdict', nodeId: 'judge', actor: agent, data: {
    verdicts: ['failure', 'ignore', 'flaky'].map((subject) => ({ subject, category: subject === 'flaky' ? 'flaky' : 'product_bug', confidence: 1, rationale: '结果失败', evidence: ['证据'] })),
    routed: [{ subject: 'ignore', to: 'ignore' }],
  } })
  await stores.events.append(run.runId, { type: 'gate.result', actor: system, data: { pass: false, checks: [
    { id: 'fail', pass: true, status: 'fail', checkpointId: 'cp-fail' }, { id: 'error', pass: false, status: 'error' },
    { id: 'pass', pass: false, status: 'pass' }, { id: 'legacy-fail', pass: false }, { id: 'legacy-pass', pass: true },
  ] } })
  await stores.events.append(run.runId, { type: 'human.answered', actor: human, data: { requestId: 'request', answer: '拒绝' } })
  expect(await quality.sync()).toEqual({ observations: 11, runs: 1 })
  const before = await log()
  expect(await quality.sync()).toEqual({ observations: 0, runs: 1 })
  expect(await log()).toEqual(before)
  const observations = await quality.observations({ requirementId: requirement.id, runId: run.runId })
  expect(observations.map((o) => o.kind)).toEqual(['finding', 'claimed_fixed', 'verified_fixed', 'declined', 'waived', 'failure', 'ignored', 'flaky', 'gate_fail', 'gate_error', 'gate_fail'])
  expect(observations[0]).toMatchObject({ id: 'review:run-quality:1:0', subject: 'ISS-1', checkpointId: 'cp-1', invocationId: 'inv-1' })
  expect(await quality.observations({ source: 'gate' })).toHaveLength(3)
  expect(await quality.defects()).toEqual([])
  expect(await quality.status()).toMatchObject({ ok: true, importedM3: true, cursors: { [run.runId]: 9 } })
})

it('追加完成但游标尚未推进时崩溃，重开后重放不重复、不漏后续观察', async () => {
  const { stores, quality, run, root } = await setup()
  await stores.events.append(run.runId, { type: 'gate.result', actor: system, data: { pass: false, checks: [{ id: 'one', pass: false }] } })
  const append = quality.append.bind(quality)
  const crash = vi.spyOn(quality, 'append').mockImplementationOnce(async (entries, options) => { await append(entries, options); throw new Error('模拟游标前崩溃') })
  await expect(quality.sync()).rejects.toThrow('游标前崩溃')
  expect((await quality.status()).cursors).toEqual({})
  crash.mockRestore()
  await stores.events.append(run.runId, { type: 'gate.result', actor: system, data: { pass: false, checks: [{ id: 'two', pass: false }] } })
  const reopened = (await openProject(root)).quality!
  expect(await reopened.sync()).toEqual({ observations: 1, runs: 1 })
  expect((await reopened.observations()).map((o) => o.subject)).toEqual(['one', 'two'])
  expect((await reopened.status()).cursors[run.runId]).toBe(2)
})

it('子进程追加后直接退出，重启无需清理同步锁即可从旧游标重放', async () => {
  const { stores, quality, run, root } = await setup()
  await stores.events.append(run.runId, { type: 'gate.result', actor: system, data: { pass: false, checks: [{ id: 'crash', pass: false }] } })
  const moduleUrl = new URL('../store/project.ts', import.meta.url).href
  const script = `import { openProject } from ${JSON.stringify(moduleUrl)};
    const quality = (await openProject(process.argv[1])).quality;
    const append = quality.append.bind(quality);
    quality.append = async (...args) => { await append(...args); process.exit(19); };
    await quality.sync();`
  await expect(promisify(execFile)(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script, root])).rejects.toMatchObject({ code: 19 })
  expect((await quality.status()).cursors).toEqual({})
  expect(await quality.sync()).toEqual({ observations: 0, runs: 1 })
  expect(await quality.observations()).toHaveLength(1)
  expect((await quality.status()).cursors[run.runId]).toBe(1)
})

it('多个同步器处理重叠运行时游标不回退，也不覆盖别的运行游标', async () => {
  const { stores, quality, run, root } = await setup()
  const second = { ...run, runId: 'run-second' }
  await stores.runs.create(second, { id: 'test', title: '测试', version: '1', nodes: [], stages: [] })
  for (const state of [run, second]) for (let i = 0; i < 5; i++) {
    await stores.events.append(state.runId, { type: 'gate.result', actor: system, data: { pass: false, checks: [{ id: String(i), pass: false }] } })
  }
  const other = (await openProject(root)).quality!
  const results = await Promise.all([quality.sync(), other.sync(second.runId), other.sync(run.runId)])
  expect(results.reduce((sum, result) => sum + result.observations, 0)).toBe(10)
  expect(await quality.observations()).toHaveLength(10)
  expect((await quality.status()).cursors).toEqual({ [run.runId]: 5, [second.runId]: 5 })
})

it('baseRevision 在去重之后检查，批内重复键跳过，冲突不写任何日志', async () => {
  const { quality, create, requirement, log } = await setup()
  await quality.append([create, create])
  const update: QualityInput = { kind: 'defect.updated', key: 'update', requirementId: requirement.id, actor: human,
    data: { id: 'D-1', validity: 'not_defect', reason: '人工核对' } }
  expect((await quality.append([update], { baseRevision: { defectId: 'D-1', revision: 1 } })).appended).toHaveLength(1)
  expect(await quality.append([update], { baseRevision: { defectId: 'D-1', revision: 1 } })).toEqual({ appended: [], skipped: ['update'] })
  const before = await log()
  await expect(quality.append([{ ...update, key: 'conflict' }], { baseRevision: { defectId: 'D-1', revision: 1 } })).rejects.toBeInstanceOf(QualityConflictError)
  expect(await log()).toEqual(before)
  expect((await quality.defects())[0]).toMatchObject({ revision: 2, validity: 'not_defect' })
})

it('人工结论、检查点改判和归因确认不被后来的自动建议覆盖，建议仍留日志', async () => {
  const { quality, requirement, create, log } = await setup()
  const attr = attribution()
  const input = (kind: QualityInput['kind'], key: string, data: unknown, actor: QualityInput['actor'] = human): QualityInput => ({ kind, key, requirementId: requirement.id, data, actor })
  await quality.append([create,
    input('defect.updated', 'manual', { id: 'D-1', validity: 'not_defect', resolution: 'accepted_risk', reason: '人工判断' }),
    input('attribution.recorded', 'human-cp', { ...attr, checkpoints: [{ checkpointId: 'cp', runId: 'run-quality', nodeId: 'review', verdict: 'out_of_scope', conditions: {}, evidence: ['职责'], by: 'human' }], reason: '人工改判' }),
    input('attribution.recorded', 'auto-cp', { ...attr, checkpoints: [{ checkpointId: 'cp', runId: 'run-quality', nodeId: 'review', verdict: 'should_have_caught', conditions: {}, evidence: ['猜测'], by: 'auditor' }], reason: '自动建议' }, agent),
    input('defect.updated', 'auto', { id: 'D-1', validity: 'valid', resolution: 'verified_fixed', reason: '自动判断' }, agent),
  ])
  expect((await quality.defects())[0]).toMatchObject({ validity: 'not_defect', resolution: 'accepted_risk', attribution: { checkpoints: [{ verdict: 'out_of_scope' }] } })
  await quality.append([
    input('attribution.confirmed', 'confirmed', { ...attr, confidence: 1, confirmed: { by: human, at: attr.at, edited: true }, reason: '确认' }),
    input('attribution.recorded', 'late', { ...attr, confidence: 0, reason: '晚到的候选' }, agent),
  ])
  expect((await quality.defects())[0]?.attribution?.confidence).toBe(1)
  expect((await log()).some((entry) => entry.key === 'late')).toBe(true)
})

it('M3 缺陷、已确认归因和 defect 样本首次导入，重开与重建都不重复', async () => {
  const { stores, quality, requirement, root, log } = await setup()
  const legacy = { ...stores, quality: undefined }
  const defect = await reportDefect(legacy, requirement.id, { title: '旧缺陷', description: '旧数据', severity: 'major' }, human)
  const attr = { ...attribution(defect.id), confirmed: { by: human, at: defect.foundAt, edited: false } }
  await stores.workspaces.writeArtifact({ ref: { workspace: requirement.id, path: `defects/${defect.id}.attribution.json` }, content: JSON.stringify(attr), kind: 'defect', author: human, reason: '旧归因' })
  const sample: EvalCase = { id: 'm3-case', title: '旧样本', target: { kind: 'node', workflowId: 'test', nodeId: 'review' }, source: { kind: 'defect', defectId: defect.id },
    node: { id: 'review', kind: 'agent', title: '检查', needs: [] }, inputs: [], grading: {}, createdAt: defect.foundAt }
  // 直接铺设 M3 文件布局；当前 saveEvalCase 已是质量日志入口，不能用于制造旧数据。
  const samplesDir = join(evalRoot(stores), targetSlug(sample.target))
  await mkdir(samplesDir, { recursive: true })
  await writeFile(join(samplesDir, `${sample.id}.json`), JSON.stringify(sample))
  await writeFile(join(samplesDir, 'manual-case.json'), JSON.stringify({ ...sample, id: 'manual-case', source: { kind: 'manual' } }))
  await quality.sync()
  const before = await log()
  expect(before.filter((e) => e.key.startsWith('m3:'))).toHaveLength(4)
  expect((await quality.defects(requirement.id))[0]).toMatchObject({ title: '旧缺陷', revision: 1, attribution: { confirmed: { by: human } } })
  const reopened = (await openProject(root)).quality!
  await reopened.rebuild(); await reopened.sync()
  expect(await log()).toEqual(before)
})

it('两个需求的 D-1 分开导入与更新；不明确的 baseRevision 拒绝', async () => {
  const { stores, quality, requirement } = await setup()
  const other = await stores.workspaces.createRequirement({ title: '另一个需求' })
  for (const req of [requirement, other]) await reportDefect({ ...stores, quality: undefined }, req.id, { title: req.title, description: '旧问题', severity: 'minor' }, human)
  await quality.sync()
  expect(await quality.defects()).toHaveLength(2)
  await quality.append([{ kind: 'defect.updated', key: 'second', requirementId: other.id, actor: human, data: { id: 'D-1', validity: 'valid', reason: '确认第二个' } }], { baseRevision: { defectId: 'D-1', revision: 1 } })
  expect((await quality.defects(requirement.id))[0]?.revision).toBe(1)
  expect((await quality.defects(other.id))[0]?.revision).toBe(2)
  await expect(quality.append([{ kind: 'recovery', key: 'ambiguous', actor: human, data: { reason: '歧义' } }], { baseRevision: { defectId: 'D-1', revision: 1 } })).rejects.toThrow('身份不唯一')
})

it('M3 导入在缺陷之后中断，重跑仍补齐归因和完成标记', async () => {
  const { stores, quality, requirement, defect, create, log } = await setup()
  const legacy = { ...stores, quality: undefined }
  await reportDefect(legacy, requirement.id, { title: defect.title, description: defect.description, severity: defect.severity }, human)
  const attr = attribution()
  await stores.workspaces.writeArtifact({ ref: { workspace: requirement.id, path: 'defects/D-1.attribution.json' },
    content: JSON.stringify(attr), kind: 'defect', author: human, reason: '旧归因' })
  await quality.append([{ ...create, key: `m3:defect:${requirement.id}:D-1` }])
  expect((await quality.status()).importedM3).toBe(false)
  await quality.sync()
  expect((await quality.defects())[0]?.attribution).toEqual(attr)
  expect((await log()).filter((entry) => entry.kind === 'defect.created')).toHaveLength(1)
  expect((await quality.status()).importedM3).toBe(true)
})

it('并发使用同一 baseRevision 只有一个成功，自动结果不能伪装人工确认', async () => {
  const { quality, create, requirement, root } = await setup()
  await quality.append([create])
  const other = (await openProject(root)).quality!
  const writes = await Promise.allSettled([quality, other].map((store, index) => store.append([{ kind: 'defect.updated',
    key: `concurrent:${index}`, requirementId: requirement.id, actor: human, data: { id: 'D-1', validity: 'valid', reason: '确认' } }],
  { baseRevision: { defectId: 'D-1', revision: 1 } })))
  expect(writes.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
  expect(writes.filter((result) => result.status === 'rejected')).toHaveLength(1)
  const attr = attribution()
  await expect(quality.append([{ kind: 'attribution.recorded', key: 'forged-human', requirementId: requirement.id, actor: agent,
    data: { ...attr, confirmed: { by: human, at: attr.at, edited: false }, reason: '伪造确认' } }])).rejects.toThrow('自动归因不能')
})

it.each(['tamper', 'truncate', 'partial', 'anchor'] as const)('检测 %s，拒绝追加和 repair，不更改损坏现场', async (mode) => {
  const { quality, create, dir } = await setup()
  await quality.append([create, { kind: 'recovery', key: 'two', actor: system, data: { reason: '测试记录' } }])
  const file = join(dir, 'log.jsonl'), original = await readFile(file, 'utf8')
  if (mode === 'tamper') await writeFile(file, original.replace('字段缺失', '偷偷改写'))
  if (mode === 'truncate') await writeFile(file, original.split('\n')[0] + '\n')
  if (mode === 'partial') await writeFile(file, original.slice(0, -5))
  if (mode === 'anchor') await writeFile(join(dir, 'anchor.json'), JSON.stringify({ seq: 2, hash: 'f'.repeat(64) }))
  const before = await readFile(file, 'utf8')
  expect((await quality.status()).ok).toBe(false)
  expect((await quality.status()).brokenAt).toBeDefined()
  await expect(quality.repair(human, '尝试修复')).rejects.toThrow('人工恢复')
  await expect(quality.append([{ ...create, key: 'new' }])).rejects.toThrow('人工恢复')
  expect(await readFile(file, 'utf8')).toBe(before)
})

it('只修复完整链的落后锚点，追加 recovery 留下原锚点与原因，重复修复无副作用', async () => {
  const { quality, create, dir, log } = await setup()
  await quality.append([create])
  const old = await readFile(join(dir, 'anchor.json'), 'utf8')
  await quality.append([{ kind: 'recovery', key: 'next', actor: system, data: { reason: '下一条' } }])
  await writeFile(join(dir, 'anchor.json'), old)
  expect(await quality.status()).toMatchObject({ ok: false, anchorBehind: true, entries: 2 })
  await expect(quality.append([{ kind: 'recovery', key: 'blocked', actor: system, data: { reason: '继续' } }])).rejects.toThrow('quality repair')
  await expect(quality.repair(human, ' ')).rejects.toThrow('原因')
  expect(await quality.repair(human, '磁盘中断后核对完整链')).toMatchObject({ ok: true, anchorBehind: false, entries: 3 })
  expect((await log()).at(-1)).toMatchObject({ kind: 'recovery', actor: human, data: { reason: '磁盘中断后核对完整链', previous: JSON.parse(old), recoveredThrough: 2 } })
  expect((await quality.repair(human, '重复核验')).entries).toBe(3)
})

it('所有读模型可删可重建，观察引用、归因、合并撤销、样本退役和评测完成都保留', async () => {
  const { quality, create, requirement, dir, log, run } = await setup()
  const observation: Observation = { id: 'external:1', source: 'external', kind: 'report', requirementId: requirement.id, title: '外部问题', at: run.startedAt, by: human }
  const sample: EvalCase = { id: 'sample', title: '样本', target: { kind: 'skill', name: 'check' }, source: { kind: 'manual' }, node: { id: 'review', title: '检查', kind: 'agent', needs: [] },
    inputs: [], grading: {}, createdAt: run.startedAt, sample: { kind: 'clean', checkpointId: 'cp', snapshot: 'frozen' } }
  const evaluation: EvalRun = { id: 'eval', target: sample.target, status: 'running', startedAt: run.startedAt, variants: [], caseIds: [], by: human, results: [] }
  const input = (kind: QualityInput['kind'], key: string, data: object): QualityInput => ({ kind, key, requirementId: requirement.id, actor: human, data: { ...data, reason: '读模型测试' } })
  await quality.append([create,
    { kind: 'observation.recorded', key: observation.id, requirementId: requirement.id, actor: human, data: observation },
    input('defect.updated', 'link', { id: 'D-1', observations: [observation.id] }),
    input('attribution.recorded', 'attr', attribution()),
    input('merge.suggested', 'suggest', { id: 'merge', defects: ['D-1', 'D-2'], status: 'suggested', at: run.startedAt }),
    input('merge.decided', 'accept', { id: 'merge', status: 'accepted', decidedBy: human, at: run.startedAt }),
    input('merge.decided', 'undo', { id: 'merge', status: 'undone', decidedBy: human, at: run.startedAt }),
    input('sample.added', 'add', sample), input('sample.retired', 'retire', { id: sample.id, retiredAt: run.startedAt }),
    input('eval.started', 'start', evaluation), input('eval.finished', 'finish', { id: evaluation.id, status: 'done' }),
  ])
  const expected = buildViews(await log())
  await rm(join(dir, 'views'), { recursive: true })
  await quality.rebuild()
  for (const name of ['observations', 'defects', 'attributions', 'merges', 'samples', 'evaluations'] as const) {
    expect(JSON.parse(await readFile(join(dir, 'views', `${name}.json`), 'utf8'))).toEqual(JSON.parse(JSON.stringify(expected[name])))
  }
  expect((await quality.observations())[0]?.defects).toEqual(['D-1'])
  expect((await quality.mergeSuggestions(requirement.id))[0]?.status).toBe('undone')
  expect((await quality.mergeSuggestions(requirement.id))[0]?.reason).toBe('读模型测试')
  expect(expected.samples[0]?.sample?.retiredAt).toBe(run.startedAt)
  expect(expected.evaluations[0]?.status).toBe('done')
})

it('缺陷文件成为投影，篡改投影不改变权威读模型；旧 store 仍能读写', async () => {
  const { stores, quality, requirement, dir } = await setup()
  const defect = await reportDefect(stores, requirement.id, { title: '真实标题', description: '真实描述', severity: 'minor' }, human)
  expect(defect.revision).toBe(1)
  const file = join(stores.workspaces.dir(requirement.id), 'defects', `${defect.id}.md`)
  await writeFile(file, '投影被误改')
  expect((await getDefect(stores, requirement.id, defect.id)).title).toBe('真实标题')
  await rm(join(dir, 'views'), { recursive: true })
  expect((await quality.defects())[0]?.title).toBe('真实标题')
  const req2 = await stores.workspaces.createRequirement({ title: '旧接口' })
  const legacy = { ...stores, quality: undefined }
  const old = await reportDefect(legacy, req2.id, { title: '兼容', description: '旧路径', severity: 'major' }, human)
  expect((await getDefect(legacy, req2.id, old.id)).title).toBe('兼容')
})

it('路径穿越和质量目录符号链接被拒绝', async () => {
  const { quality, dir, root, run } = await setup()
  await expect(quality.sync('../bad')).rejects.toThrow('非法')
  await expect(quality.defects('../bad')).rejects.toThrow('非法')
  const outside = join(root, 'outside'); await mkdir(outside)
  await symlink(outside, dir)
  await expect(quality.sync(run.runId)).rejects.toThrow('符号链接')
})

it('哈希与事件存储算法兼容，undefined 字段按实际 JSON 语义计算', async () => {
  const { stores, run } = await setup()
  const event = await stores.events.append(run.runId, { type: 'log', actor: system, data: { level: 'info', message: '验证' } })
  expect(chainHash(event)).toBe(event.hash)
  expect(chainHash({ ...event, extra: undefined } as typeof event)).toBe(event.hash)
})

it('两个独立进程同时追加共享键和独有键，不丢失不重复且链和锚点完整', async () => {
  const { root, quality, log } = await setup()
  const moduleUrl = new URL('../store/project.ts', import.meta.url).href
  const script = `import { openProject } from ${JSON.stringify(moduleUrl)};
    const stores = await openProject(process.argv[1]);
    for (let i = 0; i < 12; i++) {
      await stores.quality.append([
        { kind: 'recovery', key: 'shared:' + i, actor: { type: 'system', id: 'test' }, data: { reason: '共享写入' } },
        { kind: 'recovery', key: process.argv[2] + ':' + i, actor: { type: 'system', id: 'test' }, data: { reason: '独立写入' } }
      ]);
    }`
  await Promise.all(['one', 'two'].map((name) => promisify(execFile)(process.execPath,
    ['--import', 'tsx', '--input-type=module', '-e', script, root, name])))
  expect((await log()).length).toBe(36)
  expect(new Set((await log()).map((entry) => entry.key)).size).toBe(36)
  expect(await quality.status()).toMatchObject({ ok: true, entries: 36, anchor: { seq: 36 } })
}, 20_000)

it.each(['sample', 'evaluation'] as const)('正式 %s 读接口重建，CAS 在质量提交锁内拒绝并发写入', async objectKind => {
  const { quality, root, dir } = await setup()
  const { evalRevision } = await import('../eval/quality-access.js')
  const kind = objectKind === 'sample' ? 'sample.added' as const : 'eval.started' as const
  const read = () => objectKind === 'sample' ? quality.samples() : quality.evaluations()
  const value = { id: 'object-1', title: 'v1', baseRevision: '历史适配字段', reason: '创建' }
  await quality.append([{ kind, key: 'object:first', data: value, actor: human }], { baseRevision: { objectKind, objectId: value.id, revision: evalRevision(undefined) } })
  const first = (await read())[0]!
  expect(first).not.toHaveProperty('baseRevision')
  await rm(join(dir, 'views'), { recursive: true })
  expect(await read()).toEqual([first])
  const second = (await openProject(root)).quality!
  const options = { baseRevision: { objectKind, objectId: value.id, revision: evalRevision(first) } }
  const result = await Promise.allSettled([quality, second].map((store, i) => store.append([{ kind, key: `change:${i}`, data: { id: value.id, title: `v${i + 2}`, reason: '并发改写' }, actor: human }], options)))
  expect(result.filter(r => r.status === 'fulfilled')).toHaveLength(1)
  expect(result.find(r => r.status === 'rejected')).toMatchObject({ reason: expect.any(QualityConflictError) })
  expect((await quality.status()).ok).toBe(true)
})

it('正式调用日志校验开始和结束数据，拒绝错配身份与负耗时', async () => {
  const { quality, log } = await setup()
  const start = { id: 'inv-1', nodeId: 'review', attempt: 1, fallbackIndex: 0, role: 'reviewer', harness: 'mock', model: {}, effort: {}, skills: [], at: new Date().toISOString(), reason: '评测调用' }
  await quality.append([{ kind: 'invocation.started', key: 'start', actor: agent, data: start }])
  await quality.append([{ kind: 'invocation.finished', key: 'end', actor: agent, data: { id: start.id, outcome: 'ok', durationMs: 3, reason: '调用完成' } }])
  for (const patch of [{ id: 'other' }, { attempt: 0 }, { fallbackIndex: -1 }, { role: 'fake' }, { model: 'requested' }, { skills: [{ name: 'a', confirmed: true }] }]) {
    await expect(quality.append([{ kind: 'invocation.started', key: 'bad', actor: agent, data: { ...start, ...patch } }])).rejects.toThrow('调用')
  }
  await expect(quality.append([{ kind: 'invocation.finished', key: 'bad-end', actor: agent, data: { id: start.id, outcome: 'ok', durationMs: -1, reason: 'bad' } }])).rejects.toThrow('调用结束')
  expect((await log()).filter(e => e.kind.startsWith('invocation.'))).toHaveLength(2)
})

it('实时质量同步元数据不归因给模型，候选包与快照写入仍被守卫检查', async () => {
  const { stores, quality, run, root } = await setup()
  const { WriteGuard } = await import('../engine/guard.js')
  const guard = new WriteGuard(root, 'requirements'), finish = await guard.begin({ profile: [] })
  await stores.events.append(run.runId, { type: 'gate.result', actor: system, data: { pass: false, checks: [{ id: 'live', pass: false, status: 'fail' }] } })
  await quality.sync(run.runId)
  expect(await finish()).toMatchObject({ paths: [] })
  const malicious = await guard.begin({ profile: [] })
  for (const path of ['quality/candidates/unsafe', 'snapshots/unsafe']) {
    await mkdir(join(stores.taktDir, path), { recursive: true })
    await writeFile(join(stores.taktDir, path, 'content.txt'), '不应豁免')
  }
  expect((await malicious()).paths.sort()).toEqual(['.takt/quality/candidates/unsafe/content.txt', '.takt/snapshots/unsafe/content.txt'])
})

it('等待提交锁前冻结 baseRevision，调用者后改 options 不改变本次比较', async () => {
  const { quality } = await setup()
  const { evalRevision } = await import('../eval/quality-access.js')
  const options = { baseRevision: { objectKind: 'evaluation' as const, objectId: 'eval-freeze', revision: evalRevision(undefined) } }
  const pending = quality.append([{ kind: 'eval.started', key: 'eval-freeze', actor: human, data: { id: 'eval-freeze', reason: '创建' } }], options)
  options.baseRevision.revision = '等待期间被修改'
  await pending
  expect((await quality.evaluations())[0]!.id).toBe('eval-freeze')
})

it('绕过 eval 写锁的直接质量写入也会使评测 CAS 失败', async () => {
  const { stores, quality } = await setup()
  const { appendEvalObject, evalRevision } = await import('../eval/quality-access.js')
  const value: EvalRun = { id: 'eval-cas', target: { kind: 'node', workflowId: 'w', nodeId: 'n' }, variants: [], caseIds: [], status: 'running', startedAt: new Date().toISOString(), by: human, results: [] }
  await appendEvalObject(stores, 'eval.started', value, { by: human, reason: '开始', baseRevision: evalRevision(undefined) })
  const original = quality.append.bind(quality)
  vi.spyOn(quality, 'append').mockImplementationOnce(async (entries, options) => {
    await original([{ kind: 'eval.finished', key: 'external-write', actor: human, data: { id: value.id, status: 'refused', reason: '另一入口写入' } }])
    return original(entries, options)
  })
  await expect(appendEvalObject(stores, 'eval.finished', { ...value, status: 'done' }, { by: human, reason: '本次结束', baseRevision: evalRevision(value) })).rejects.toBeInstanceOf(QualityConflictError)
  expect((await quality.evaluations())[0]!.status).toBe('refused')
})
