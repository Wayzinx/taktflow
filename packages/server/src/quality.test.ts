import { chmod, mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { acquireLease, initProject, putObject, readLease, releaseLease, syncObservations, withSpaceLease,
  type Actor, type EventPayloads, type Observation, type ProjectStores } from '@taktflow/core'
import { createApiCore } from './api-core.js'
import { createServer } from './index.js'
import { watchQualityEvents } from './quality-feed.js'

const cleanups: Array<() => Promise<unknown>> = []
async function remove(root: string): Promise<void> {
  await chmod(root, 0o755)
  for (const item of await readdir(root, { withFileTypes: true })) if (item.isDirectory()) await remove(join(root, item.name))
  await rm(root, { recursive: true, force: true })
}
afterEach(async () => { vi.restoreAllMocks(); for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
const human: Actor = { type: 'human', id: 'alice', via: 'dsh-web' }
const system: Actor = { type: 'system', id: 'test' }

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'takt-quality-api-')); cleanups.push(() => remove(root))
  const stores = await initProject(root)
  await stores.workspaces.createRequirement({ id: 'REQ-1', title: '质量' })
  const observation: Observation = { id: 'review:run-1:3:0', requirementId: 'REQ-1', source: 'review', kind: 'found', runId: 'run-1', nodeId: 'review',
    subject: { artifact: { workspace: 'REQ-1', path: 'spec.md', version: 1 } }, issueKey: 'ISS-1', severity: 'major', text: '缺少条件', evidence: ['run:run-1:3'], at: new Date().toISOString() }
  await stores.quality!.append([{ type: 'observation.recorded', data: observation, actor: system }], { idempotencyKeys: [observation.id] })
  const input = { requirementId: 'REQ-1', observations: [observation.id], title: '验收条件遗漏', severity: 'major' }
  const api = createApiCore()
  return { root, stores, observation, input, api }
}

async function captured(stores: ProjectStores, runId = 'run-1') {
  await stores.runs.create({ runId, workflowId: 'wf', workflowVersion: '1', requirementId: 'REQ-1', status: 'running', startedAt: new Date().toISOString(), args: {}, nodes: {}, expansions: [] }, {
    id: 'wf', version: '1', title: 'wf', stages: [], nodes: [{ id: 'review', kind: 'review', title: 'review', needs: [],
      review: { target: ['spec.md'], author: 'author', reviewers: [{ role: 'reviewer' }], pass: 'all', maxRounds: 2, onExhausted: 'human' } }],
  })
  const ref = { workspace: 'REQ-1', path: 'spec.md', version: 1 }
  const checkpointId = `${runId}:review:1:1:reviewer`
  await stores.events.append(runId, { nodeId: 'review', type: 'checkpoint.scheduled', actor: system, data: { checkpointId, runId, nodeId: 'review', attempt: 1, round: 1, reviewer: 'reviewer', materials: [{ ref, role: 'target', sha256: 'a'.repeat(64) }], status: 'scheduled' } })
  const invocationId = `${runId}:2`
  const asset = { kind: 'inline' as const, id: 'duty', sha256: 'a'.repeat(64) }
  const data: EventPayloads['invocation.started'] = {
    invocation: { invocationId, runId, nodeId: 'review', attempt: 1, fallbackIndex: 0, checkpointId, review: { part: 'reviewer', round: 1, reviewer: 'reviewer' }, recipeId: 'recipe', inputSnapshotId: 'snapshot', resolved: { harness: 'mock' }, replay: 'limited' },
    recipe: { recipeId: 'recipe', role: 'reviewer', profile: asset, skills: [], template: asset, harness: 'mock' },
    inputSnapshot: { inputSnapshotId: 'snapshot', request: { prompt: 'a'.repeat(64) }, inputs: [{ ref, role: 'target', object: 'a'.repeat(64), sha256: 'a'.repeat(64) }], cwdLayout: { root: '.', paths: {} }, redactions: 0,
      render: { rendererVersion: 'v1', template: { kind: 'review-reviewer', object: 'a'.repeat(64) }, params: 'a'.repeat(64), assets: [], exec: { adapter: 'mock', adapterVersion: '1', tools: [], permissions: 'read', env: [] } } },
  }
  await stores.events.append(runId, { nodeId: 'review', type: 'invocation.started', actor: system, data })
  const result = () => stores.events.append(runId, { nodeId: 'review', type: 'review.result', actor: system, data: { checkpointId, invocationId, references: [],
    record: { round: 1, reviewer: 'reviewer', verdict: 'request_changes', summary: '', issues: [{ key: 'ISS-1', id: 'one', description: '缺少条件', severity: 'major' }], artifacts: [ref], at: new Date().toISOString() } } })
  return { invocationId, checkpointId, asset, result }
}

it('人工从观察创建缺陷，拒绝代理确认、缺 via、缺失或跨需求观察', async () => {
  const { stores, input, api } = await fixture()
  await expect(api.write(stores, 'defect.create', {}, input, system)).rejects.toMatchObject({ status: 400 })
  await expect(api.write(stores, 'defect.create', {}, input, { type: 'human', id: 'alice' })).rejects.toMatchObject({ status: 400 })
  await expect(api.write(stores, 'defect.create', {}, { ...input, observations: ['absent'] }, human)).rejects.toMatchObject({ status: 404 })
  await stores.workspaces.createRequirement({ id: 'REQ-2', title: '另一个需求' })
  await expect(api.write(stores, 'defect.create', {}, { ...input, requirementId: 'REQ-2' }, human)).rejects.toMatchObject({ status: 400 })
  expect(await api.write(stores, 'defect.create', {}, input, human)).toMatchObject({ id: 'DEF-REQ-1-1', validity: 'valid', resolution: 'open', revision: 1, createdBy: human })
  expect(await stores.quality!.verify()).toEqual({ ok: true })
})

it('同 owner 并发 baseRevision 只有一次提交成功；租约冲突也是 409', async () => {
  const { stores, input, api } = await fixture()
  await api.write(stores, 'defect.create', {}, input, human)
  const outcomes = await Promise.allSettled(['改判', '确认'].map((reason) => api.write(stores, 'defect.update', { id: 'DEF-REQ-1-1' }, { baseRevision: 1, patch: { title: reason }, reason }, human)))
  expect(outcomes.filter((item) => item.status === 'fulfilled')).toHaveLength(1)
  expect(outcomes.find((item) => item.status === 'rejected')).toMatchObject({ reason: { status: 409, detail: { code: 'QUALITY_REVISION_CONFLICT', expected: 1, actual: 2 } } })
  await acquireLease(stores.taktDir, 'external')
  try { await expect(api.write(stores, 'defect.create', {}, input, human)).rejects.toMatchObject({ status: 409 }) }
  finally { await releaseLease(stores.taktDir, 'external') }
})

it('合并在一个批次检查双方 revision，失败不留下半次修改；支持标重复、改状态与归因', async () => {
  const { stores, input, api } = await fixture()
  await api.write(stores, 'defect.create', {}, input, human)
  await api.write(stores, 'defect.create', {}, input, human)
  const update = { baseRevision: 1, reason: '同根因', merge: { id: 'DEF-REQ-1-2', baseRevision: 2 } }
  await expect(api.write(stores, 'defect.update', { id: 'DEF-REQ-1-1' }, update, human)).rejects.toMatchObject({ status: 409 })
  expect((await stores.quality!.defects()).map((item) => item.revision)).toEqual([1, 1])
  await api.write(stores, 'defect.update', { id: 'DEF-REQ-1-1' }, { ...update, merge: { ...update.merge, baseRevision: 1 } }, human)
  expect(await stores.quality!.defect('DEF-REQ-1-2')).toMatchObject({ validity: 'duplicate', duplicateOf: 'DEF-REQ-1-1', revision: 2 })
  const value = { status: 'unknown', rationale: '证据不足', candidates: [], escapes: [], evidence: [] }
  expect(await api.write(stores, 'attribution.record', {}, { defectId: 'DEF-REQ-1-1', baseRevision: 2, attribution: value }, human)).toMatchObject({ revision: 3, attribution: { method: 'human', status: 'unknown', by: human } })
  await expect(api.write(stores, 'attribution.record', {}, { defectId: 'DEF-REQ-1-1', baseRevision: 2, attribution: value }, human)).rejects.toMatchObject({ status: 409 })
  await api.write(stores, 'defect.update', { id: 'DEF-REQ-1-1' }, { baseRevision: 3, reason: '改判', patch: { validity: 'not_a_defect', resolution: 'accepted_risk' } }, human)
  expect(await api.read(stores, 'quality.defects', { status: 'not_a_defect' })).toHaveLength(1)
  const before = await stores.quality!.read()
  expect(await api.read(stores, 'quality.attribution.candidates', { defectId: 'DEF-REQ-1-1' })).toMatchObject({ defectId: 'DEF-REQ-1-1', revision: 4, judgment: false })
  expect(await stores.quality!.read()).toEqual(before)
})

it('读取调用完成状态和检查点；样本新增/退休冲突、候选幂等，eval.start 明确 501', async () => {
  const { stores, api } = await fixture()
  const { invocationId, checkpointId, asset, result } = await captured(stores)
  expect(await api.read(stores, 'quality.checkpoint', { checkpointId })).toMatchObject({ status: 'scheduled' })
  await stores.events.append('run-1', { type: 'invocation.finished', actor: system, nodeId: 'review', data: { invocationId, outcome: { status: 'ok' }, reported: { model: 'model' } } })
  await result()
  expect(await api.read(stores, 'quality.invocation', { invocationId })).toMatchObject({ invocation: { outcome: { status: 'ok' }, reported: { model: 'model' } }, recipe: { recipeId: 'recipe' }, inputSnapshot: { inputSnapshotId: 'snapshot' } })
  expect(await api.read(stores, 'quality.checkpoint', { checkpointId })).toMatchObject({ status: 'completed', invocationId })
  const item = { id: 'case-1', kind: 'clean', target: { role: 'reviewer', template: asset }, frozen: { invocationId, inputSnapshotId: 'snapshot' }, expectation: { kind: 'clean', allowedSeverities: ['nit'] }, status: 'active' }
  expect(await api.write(stores, 'evalcase.add', {}, { case: item }, human)).toMatchObject({ revision: 1 })
  await expect(api.write(stores, 'evalcase.add', {}, { case: { ...item, id: 'bad', target: { ...item.target, role: 'wrong' } } }, human)).rejects.toMatchObject({ status: 400 })
  expect(await api.write(stores, 'evalcase.update', { id: 'case-1' }, { baseRevision: 1, status: 'retired', reason: '样本过期' }, human)).toMatchObject({ revision: 2, status: 'retired' })
  await expect(api.write(stores, 'evalcase.update', { id: 'case-1' }, { baseRevision: 1, status: 'active', reason: '并发编辑' }, human)).rejects.toMatchObject({ status: 409 })
  const content = await putObject(stores, 'new duty')
  const candidate = { replaces: [{ asset, content }], note: '试验' }
  const first = await api.write(stores, 'candidate.create', {}, candidate, human)
  expect(await api.write(stores, 'candidate.create', {}, candidate, human)).toEqual(first)
  expect(await api.read(stores, 'quality.candidates', {})).toHaveLength(1)
  await expect(api.write(stores, 'eval.start', {}, {}, human)).rejects.toMatchObject({ status: 501 })
  expect(await api.read(stores, 'quality.evals', {})).toEqual([])
})

it('HTTP 路由委托 api-core，保留 via、参数错误、404 和 revision 冲突', async () => {
  const { root, stores, input } = await fixture()
  const { invocationId, checkpointId } = await captured(stores)
  const server = await createServer({ projectDir: root, port: 0 }); cleanups.push(() => server.close())
  const request = async (path: string, method = 'GET', body?: unknown) => {
    const response = await fetch(`${server.url}/api/quality/${path}`, { method, headers: { 'content-type': 'application/json', 'x-takt-user': 'alice' }, body: body === undefined ? undefined : JSON.stringify(body) })
    return { status: response.status, data: await response.json() }
  }
  expect(await request('defects', 'POST', input)).toMatchObject({ status: 200, data: { id: 'DEF-REQ-1-1', createdBy: { type: 'human', id: 'alice', via: 'web' } } })
  expect(await request('defects/DEF-REQ-1-1')).toMatchObject({ status: 200, data: { revision: 1 } })
  expect(await request('defects/DEF-REQ-1-1', 'PATCH', { baseRevision: 2, patch: { title: '竞争' }, reason: '测试' })).toMatchObject({ status: 409 })
  expect(await request('observations?requirement=REQ-1&issueKey=ISS-1')).toMatchObject({ status: 200, data: [expect.objectContaining({ issueKey: 'ISS-1' })] })
  for (const path of [`invocations/${encodeURIComponent(invocationId)}`, `checkpoints/${encodeURIComponent(checkpointId)}`, 'defects', 'evalcases', 'candidates', 'evals']) expect((await request(path)).status, path).toBe(200)
  expect((await request('observations')).status).toBe(400)
  expect((await request('defects?status=invalid')).status).toBe(400)
  expect((await request('evals/missing')).status).toBe(404)
  expect((await request('evals', 'POST', {})).status).toBe(501)
})

it('serve 增量订阅历史与新增运行，在空间租约内提交，关闭后不再处理', async () => {
  const { stores } = await fixture()
  const errors: unknown[] = []
  let commits = 0
  const append = stores.quality!.advanceCursor.bind(stores.quality!)
  vi.spyOn(stores.quality!, 'advanceCursor').mockImplementation(async (cursor, batch) => {
    expect((await readLease(stores.taktDir))?.owner).toBe('serve-test')
    commits++
    return append(cursor, batch)
  })
  const first = await captured(stores, 'run-before')
  await first.result()
  const stop = await watchQualityEvents(stores, { pollMs: 20, withWriteLease: (_, fn) => withSpaceLease(stores.taktDir, 'serve-test', fn), onError: (error) => errors.push(error) })
  cleanups.push(stop)
  await vi.waitFor(async () => expect(await stores.quality!.observations({ run: 'run-before' })).toHaveLength(1))
  const second = await captured(stores, 'run-after')
  await second.result()
  await vi.waitFor(async () => expect(await stores.quality!.observations({ run: 'run-after' })).toHaveLength(1))
  expect(errors).toEqual([])
  await stop()
  const previous = commits
  await second.result()
  await new Promise((resolve) => setTimeout(resolve, 60))
  expect(commits).toBe(previous)
  await withSpaceLease(stores.taktDir, 'serve-test', () => syncObservations(stores, 'run-after'))
  expect(await stores.quality!.observations({ run: 'run-after' })).toHaveLength(2)
})
