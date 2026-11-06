import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { chmod, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Actor } from '../types.js'
import type { AttributionView, EvalCaseView, Observation } from '../quality.js'
import { FsQualityStore } from './fs-quality.js'
import { FsEventStore } from './fs-events.js'
import { canonicalJson, sha256 } from '../util/hash.js'
import * as io from './fs-utils.js'
import { putObject } from './objects.js'
import { QualityRevisionConflict, type QualityEventInput } from './quality-store.js'
import { initProject } from './project.js'

const actor: Actor = { type: 'human', id: 'tester', via: 'cli' }
const now = '2026-11-06T00:00:00.000Z'
const create = (id = 'D-1'): QualityEventInput => ({ type: 'defect.created', actor, data: { defect: {
  id, requirementId: 'REQ-1', title: '遗漏边界', severity: 'major', observations: [], validity: 'unconfirmed',
  resolution: 'open', createdBy: actor, createdAt: now,
} } })
const update = (baseRevision = 1, title = '人工确认'): QualityEventInput => ({ type: 'defect.updated', actor,
  data: { id: 'D-1', baseRevision, patch: { title, validity: 'valid' }, reason: '复核', by: actor } })
const observation = (seq = 1): Observation => ({ id: `review:run-1:${seq}:0`, source: 'review', kind: 'found',
  requirementId: 'REQ-1', runId: 'run-1', issueKey: 'ISS-1', subject: {}, text: '缺少边界', evidence: [], at: now })
const sample: EvalCaseView = { id: 'CASE-1', revision: 1, kind: 'must_catch', target: { role: 'reviewer',
  template: { kind: 'inline', id: 'checklist', sha256: sha256('template') } }, frozen: { invocationId: 'run-1:1', inputSnapshotId: 'input-1' },
  expectation: { kind: 'must_catch', issue: '缺少边界' }, status: 'active' }

let root: string
let takt: string
let store: FsQualityStore
const file = (name: string) => path.join(takt, 'quality', name)

async function removeReadonly(dir: string): Promise<void> {
  await chmod(dir, 0o755)
  for (const entry of await readdir(dir, { withFileTypes: true })) if (entry.isDirectory()) await removeReadonly(path.join(dir, entry.name))
}
beforeEach(async () => { root = await mkdtemp(path.join(os.tmpdir(), 'quality-store-')); takt = path.join(root, '.takt'); store = new FsQualityStore(takt) })
afterEach(async () => { vi.restoreAllMocks(); await removeReadonly(root); await rm(root, { recursive: true, force: true }) })

describe('质量提交与恢复', () => {
  it('openProject 创建可选质量存储，旧的 ProjectStores 保持兼容', async () => {
    const stores = await initProject(root)
    expect(stores.quality).toBeInstanceOf(FsQualityStore)
    expect(await stores.quality!.verify()).toEqual({ ok: true })
  })

  it('不同实例并发同一 baseRevision，仅一次成功', async () => {
    await store.append([create()], { idempotencyKeys: ['create'] })
    const other = new FsQualityStore(takt)
    const results = await Promise.allSettled([store.append([update()], { idempotencyKeys: ['u1'], baseRevisions: { 'defect:D-1': 1 } }),
      other.append([update(1, '另一个修改')], { idempotencyKeys: ['u2'], baseRevisions: { 'defect:D-1': 1 } })])
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    const failed = results.find((r) => r.status === 'rejected') as PromiseRejectedResult
    expect(failed.reason).toBeInstanceOf(QualityRevisionConflict)
    expect((await store.defect('D-1'))?.revision).toBe(2)
    expect(await store.read()).toHaveLength(2)
  })

  it('跨进程竞争仍在同一日志提交锁内', async () => {
    await store.append([create()], { idempotencyKeys: ['create'] })
    const script = `import { FsQualityStore } from ${JSON.stringify(new URL('./fs-quality.ts', import.meta.url).href)};
      const store = new FsQualityStore(process.argv[1]);
      const event = JSON.parse(process.argv[3]);
      try { await store.append([event], { idempotencyKeys: [process.argv[2]] }); process.stdout.write('ok'); }
      catch (e) { if (e.code !== 'QUALITY_REVISION_CONFLICT') throw e; process.stdout.write('conflict'); }`
    const run = promisify(execFile)
    const result = await Promise.all(['a', 'b'].map((key) => run(process.execPath,
      ['--import', 'tsx', '--input-type=module', '-e', script, takt, key, JSON.stringify(update(1, key))], { cwd: process.cwd() })))
    expect(result.map((r) => r.stdout).sort()).toEqual(['conflict', 'ok'])
    expect(await store.verify()).toEqual({ ok: true })
  })

  it('幂等重试先于 revision 检查；键内容冲突拒绝且批内重复只写一次', async () => {
    await store.append([create()], { idempotencyKeys: ['create'] })
    const first = await store.append([update(), update()], { idempotencyKeys: ['update', 'update'], baseRevisions: { 'defect:D-1': 1 } })
    expect(first.appended).toBe(1)
    expect(first.events[0]).toEqual(first.events[1])
    const retry = await store.append([update()], { idempotencyKeys: ['update'], baseRevisions: { 'defect:D-1': 1 } })
    expect(retry.appended).toBe(0)
    expect(retry.revisions['defect:D-1']).toBe(2)
    await expect(store.append([update(1, '不同')], { idempotencyKeys: ['update'] })).rejects.toThrow('内容不同')
    expect(await store.read()).toHaveLength(2)
  })

  it('整批先检查，后续 revision 冲突不会写入前面的事件', async () => {
    await store.append([create()], { idempotencyKeys: ['create'] })
    await expect(store.append([create('D-2'), update(99)], { idempotencyKeys: ['create2', 'bad'] })).rejects.toThrow('revision 冲突')
    expect(await store.defect('D-2')).toBeUndefined()
    expect(await store.read()).toHaveLength(1)
  })

  it('追加后写锚点失败：拒绝继续追加，repair 追加审计且恢复游标', async () => {
    await store.append([create()], { idempotencyKeys: ['create'] })
    const before = await readFile(file('cursors.json'), 'utf8')
    const realWrite = io.writeFileAtomic
    const spy = vi.spyOn(io, 'writeFileAtomic').mockImplementation(async (target, bytes) => {
      if (target === file('chain.json')) throw new Error('模拟锚点写入中断')
      await realWrite(target, bytes)
    })
    const cursor = { runId: 'run-1', processor: 'review', processorVersion: '1', seq: 3 }
    await expect(store.advanceCursor(cursor, { events: [update()], idempotencyKeys: ['update'] })).rejects.toThrow('模拟锚点')
    spy.mockRestore()
    expect(await readFile(file('cursors.json'), 'utf8')).toBe(before)
    expect(await store.verify()).toEqual({ ok: false, reason: 'incomplete', brokenAt: 2 })
    await expect(store.append([create('D-2')], { idempotencyKeys: ['blocked'] })).rejects.toThrow('incomplete')
    await expect(store.getCursor(cursor)).rejects.toThrow('incomplete')
    const repaired = await store.repair()
    expect(repaired.events[0]?.type).toBe('log.recovered')
    expect(await store.verify()).toEqual({ ok: true })
    expect(await store.getCursor(cursor)).toBe(3)
    expect((await store.defect('D-1'))?.revision).toBe(2)
    await expect(store.repair()).rejects.toThrow('无需修复')
  })

  it('首批日志没有锚点也识别为 incomplete 并可恢复', async () => {
    await store.append([create()], { idempotencyKeys: ['create'] })
    await rm(file('chain.json'))
    expect(await store.verify()).toMatchObject({ reason: 'incomplete' })
    await store.repair()
    expect(await store.verify()).toEqual({ ok: true })
  })

  it.each(['tampered', 'truncated', 'partial-batch', 'partial-line', 'anchor', 'missing'])('%s 拒绝 repair 且不修改证据', async (kind) => {
    await store.append([create()], { idempotencyKeys: ['create'] })
    const oldAnchor = await readFile(file('chain.json'))
    await store.append([update(), create('D-2')], { idempotencyKeys: ['update', 'second'] })
    let text = await readFile(file('log.jsonl'), 'utf8')
    if (kind === 'tampered') text = text.replace('遗漏边界', '被篡改')
    if (kind === 'truncated') text = text.split('\n').slice(0, 1).join('\n') + '\n'
    if (kind === 'partial-batch') {
      text = text.split('\n').slice(0, 2).join('\n') + '\n'
      await writeFile(file('chain.json'), oldAnchor)
    }
    if (kind === 'partial-line') text = text.slice(0, -2)
    if (kind === 'anchor') await writeFile(file('chain.json'), '{}')
    await writeFile(file('log.jsonl'), text)
    if (kind === 'missing') await rm(file('log.jsonl'))
    expect((await store.verify()).ok).toBe(false)
    await expect(store.repair()).rejects.toThrow('拒绝修复')
    if (kind !== 'missing') expect(await readFile(file('log.jsonl'), 'utf8')).toBe(text)
  })
})

describe('读模型、候选包与游标', () => {
  it('所有读模型可删可重建；评测集修订冻结，空缺结果保持 insufficient', async () => {
    const obs = observation()
    const attribution: AttributionView = { status: 'confirmed', method: 'human', escapes: [], candidates: [], rationale: '逐段复核', evidence: [], by: actor, at: now }
    const candidate = await store.createCandidate({ replaces: [], exec: { model: 'candidate' }, createdBy: actor, note: '试验' })
    const events: QualityEventInput[] = [
      { type: 'observation.recorded', actor, data: obs }, create(),
      { type: 'defect.updated', actor, data: { id: 'D-1', baseRevision: 1, patch: { addObservations: [obs.id] }, by: actor, reason: '关联' } },
      { type: 'attribution.recorded', actor, data: { defectId: 'D-1', baseRevision: 2, attribution } },
      { type: 'evalcase.added', actor, data: { case: sample } },
      { type: 'eval.started', actor, data: { evalId: 'E-1', candidateId: candidate.candidateId, baseline: 'origin', caseIds: [sample.id], samples: 3, judgeRecipeId: 'judge', by: actor } },
      { type: 'eval.sample', actor, data: { evalId: 'E-1', caseId: sample.id, arm: 'candidate', index: 1, outcome: 'fail', falsePositive: true, note: '误报' } },
      { type: 'evalcase.updated', actor, data: { id: sample.id, baseRevision: 1, status: 'retired', by: actor, reason: '撤销' } },
      { type: 'eval.finished', actor, data: { evalId: 'E-1', status: 'done' } },
    ]
    await store.append(events, { idempotencyKeys: events.map((_, i) => i === 0 ? obs.id : `e-${i}`) })
    const before = await Promise.all([store.defects(), store.observations(), store.evalcases(), store.candidates(), store.evals()])
    expect(before[0][0]).toMatchObject({ revision: 3, observations: [obs.id], attribution })
    expect(await store.eval('E-1')).toMatchObject({ kind: 'exploratory', evalSetRevision: sha256(canonicalJson([sample])),
      cases: [{ candidate: ['insufficient', 'fail', 'insufficient'], falsePositives: { baseline: 0, candidate: 1 } }] })
    expect(await store.defects({ requirement: 'REQ-other' })).toEqual([])
    expect(await store.observations({ requirement: 'REQ-1', run: 'run-1', issueKey: 'ISS-1' })).toEqual([obs])
    expect(await store.evalcases({ status: 'active' })).toEqual([])
    await rm(file('views'), { recursive: true })
    const fresh = new FsQualityStore(takt)
    await fresh.rebuild()
    expect(await Promise.all([fresh.defects(), fresh.observations(), fresh.evalcases(), fresh.candidates(), fresh.evals()])).toEqual(before)
    const cache = JSON.parse(await readFile(file('views/defects.json'), 'utf8'))
    expect(cache.seq).toBe(10)
    await writeFile(file('views/defects.json'), '{invalid cache')
    expect(await fresh.defects()).toEqual(before[0])
  })

  it('自动归因不能覆盖人工确认', async () => {
    const confirmed: AttributionView = { status: 'confirmed', method: 'human', candidates: [], escapes: [], evidence: [], rationale: '已审', by: actor, at: now }
    await store.append([create(), { type: 'attribution.recorded', actor, data: { defectId: 'D-1', baseRevision: 1, attribution: confirmed } }], { idempotencyKeys: ['create', 'human'] })
    await expect(store.append([{ type: 'attribution.recorded', actor, data: { defectId: 'D-1', baseRevision: 2,
      attribution: { ...confirmed, method: 'agent_suggested', status: 'candidate' } } }], { idempotencyKeys: ['agent'] })).rejects.toThrow('人工结论')
    expect((await store.defect('D-1'))?.revision).toBe(2)
  })

  it('同内容候选包并发创建幂等，正文只读且拒绝对象缺失和篡改', async () => {
    const hash = await putObject(takt, '替换后的正文')
    const input = { replaces: [{ asset: { kind: 'inline' as const, id: 'profile', sha256: sha256('原正文') }, content: hash }], createdBy: actor, note: '试验' }
    const [first, second] = await Promise.all([store.createCandidate(input), new FsQualityStore(takt).createCandidate(input)])
    expect(first).toEqual(second)
    expect(await store.read()).toHaveLength(1)
    expect(await readFile(file(`evals/candidates/${first.candidateId}/objects/${hash}`), 'utf8')).toBe('替换后的正文')
    const manifest = file(`evals/candidates/${first.candidateId}/candidate.json`)
    await expect(writeFile(manifest, '{}')).rejects.toThrow()
    await chmod(manifest, 0o644)
    await writeFile(manifest, '{}')
    await expect(store.createCandidate(input)).rejects.toThrow()
    await expect(store.createCandidate({ ...input, note: '缺失', replaces: [{ ...input.replaces[0]!, content: sha256('missing') }] })).rejects.toThrow('对象缺失')
    expect(await store.read()).toHaveLength(1)
  })

  it('处理失败或 revision 冲突不推进游标；按版本重放、去重且不信任领先的缓存', async () => {
    const events = new FsEventStore(takt)
    const key = { runId: 'run-1', processor: 'review', processorVersion: '1' }
    for (let i = 0; i < 3; i++) await events.append(key.runId, { type: 'log', actor, data: { level: 'info', message: String(i) } })
    const process = vi.fn(async (event: { seq: number }) => {
      const obs = observation(event.seq)
      return { events: [{ type: 'observation.recorded' as const, actor, data: obs }], idempotencyKeys: [obs.id] }
    })
    expect(await store.replayFromCursor(events, key, process)).toBe(3)
    expect(process).toHaveBeenCalledTimes(3)
    expect(await store.replayFromCursor(events, key, process)).toBe(3)
    expect(process).toHaveBeenCalledTimes(3)
    expect(await store.getCursor({ ...key, processorVersion: '2' })).toBe(0)
    await writeFile(file('cursors.json'), JSON.stringify({ data: { [JSON.stringify([key.runId, key.processor, key.processorVersion])]: { ...key, seq: 100 } } }))
    expect(await store.getCursor(key)).toBe(3)
    await rm(file('cursors.json'))
    expect(await store.replayFromCursor(events, { ...key, processorVersion: '2' }, process)).toBe(3)
    expect(await store.observations()).toHaveLength(3)
    const v3 = { ...key, processorVersion: '3' }
    await expect(store.replayFromCursor(events, v3, async () => { throw new Error('分析失败') })).rejects.toThrow('分析失败')
    expect(await store.getCursor(v3)).toBe(0)
    await expect(store.advanceCursor({ ...v3, seq: 1 }, { events: [update(9)], idempotencyKeys: ['bad'] })).rejects.toThrow()
    expect(await store.getCursor(v3)).toBe(0)
    await store.advanceCursor({ ...key, seq: 1 }, { events: [], idempotencyKeys: [] })
    expect(await store.getCursor(key)).toBe(3)
  })
})
