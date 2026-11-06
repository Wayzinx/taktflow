import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { initProject, openProject } from '../store/project.js'
import type { Actor, EventPayloads, EventType, ReviewIssue, ReviewNodeDef, ReviewRecord, SnapshotNode } from '../types.js'
import { OBSERVATION_PROCESSOR, OBSERVATION_PROCESSOR_VERSION, syncObservations } from './observe.js'

const roots: string[] = []
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))) })
const system: Actor = { type: 'system', id: 'test' }
const issue = (key = 'ISS-1', id = '1'): ReviewIssue => ({ id, key, description: '缺少验收条件', severity: 'major', location: 'spec.md:3' })
const node = (id: string, target: ReviewNodeDef['target'] = ['spec.md']): SnapshotNode => ({
  id, kind: 'review', title: id, needs: [], review: { target, author: 'author', reviewers: [{ role: 'reviewer' }], pass: 'all', maxRounds: 3, onExhausted: 'human' },
})

async function fixture(nodes = [node('review')]) {
  const root = await mkdtemp(join(tmpdir(), 'takt-observe-')); roots.push(root)
  const stores = await initProject(root)
  await stores.workspaces.createRequirement({ id: 'REQ-1', title: '观察' })
  const ref = { workspace: 'REQ-1', path: 'spec.md', version: 1 }
  await stores.runs.create({ runId: 'run-1', workflowId: 'wf', workflowVersion: '1', requirementId: 'REQ-1', args: {}, expansions: [], nodes: {}, status: 'running', startedAt: new Date().toISOString() }, { id: 'wf', title: 'wf', version: '1', stages: [], nodes })
  const event = <T extends EventType>(type: T, data: EventPayloads[T], nodeId = 'review', actor = system) => stores.events.append('run-1', { type, data, nodeId, actor })
  const result = async (round: number, issues: ReviewIssue[], previous?: ReviewRecord['previous'], reviewer = 'reviewer', nodeId = 'review', attempt = 1) => {
    const checkpointId = `run-1:${nodeId}:${attempt}:${round}:${reviewer}`
    await event('checkpoint.scheduled', { checkpointId, runId: 'run-1', nodeId, attempt, round, reviewer, materials: [{ ref, sha256: 'a'.repeat(64), role: 'target' }], status: 'scheduled' }, nodeId)
    return event('review.result', { checkpointId, record: { reviewer, round, verdict: issues.length ? 'request_changes' : 'approve', summary: '', issues, previous, artifacts: [ref], at: new Date().toISOString() }, references: [] }, nodeId)
  }
  const sync = () => syncObservations(stores, 'run-1')
  return { root, stores, ref, event, result, sync }
}

it('重复 sync 与丢失缓存恢复不会重复入账，观察和游标属于同一提交', async () => {
  const { root, stores, result, sync } = await fixture()
  const source = await result(1, [issue()])
  expect(await sync()).toMatchObject({ observations: 1, seq: source.seq })
  const log = await stores.quality!.read()
  const observation = log.find((entry) => entry.type === 'observation.recorded')!
  expect(observation.idempotencyKey).toBe(`review:run-1:${source.seq}:0`)
  expect(log.find((entry) => entry.type === 'cursor.advanced' && entry.data.seq === source.seq)?.commitId).toBe(observation.commitId)
  expect(await sync()).toMatchObject({ observations: 0 })
  await rm(join(stores.taktDir, 'quality/cursors.json'))
  const reopened = await openProject(root)
  expect(await syncObservations(reopened, 'run-1')).toMatchObject({ observations: 0, seq: source.seq })
  expect(await reopened.quality!.observations()).toHaveLength(1)
  expect(await stores.quality!.read()).toHaveLength(log.length)
})

it('提交失败只停在上一游标；重开后重建已有问题上下文继续复查', async () => {
  const { root, stores, result, sync } = await fixture()
  await result(1, [issue()]); await sync()
  const source = await result(2, [], [{ key: 'ISS-1', status: 'resolved', note: '已验证条件' }])
  const original = stores.quality!.advanceCursor.bind(stores.quality!)
  vi.spyOn(stores.quality!, 'advanceCursor').mockImplementation(async (cursor, batch) => {
    if (cursor.seq === source.seq) throw new Error('注入提交失败')
    return original(cursor, batch)
  })
  await expect(sync()).rejects.toThrow('注入提交失败')
  expect(await stores.quality!.getCursor({ runId: 'run-1', processor: OBSERVATION_PROCESSOR, processorVersion: OBSERVATION_PROCESSOR_VERSION })).toBe(source.seq - 1)
  const reopened = await openProject(root)
  await syncObservations(reopened, 'run-1')
  expect((await reopened.quality!.observations()).map((item) => item.kind)).toEqual(['found', 'verified_fixed'])
})

it('作者 fixed、批准、没提和 not_checked 都不能生成 verified_fixed', async () => {
  const { stores, event, result, sync } = await fixture()
  await result(1, [issue()])
  await event('review.response', { round: 1, responses: [{ round: 1, reviewer: 'reviewer', issueId: '1', action: 'fixed', note: '作者说已修' }], revised: [] })
  await result(2, [])
  await result(3, [], [{ key: 'ISS-1', status: 'not_checked' }])
  await event('human.requested', { requestId: 'signoff', ask: '批准', form: 'approve' })
  await event('human.answered', { requestId: 'signoff', decision: 'approve' }, 'review', { type: 'human', id: 'alice', via: 'cli' })
  await sync()
  expect((await stores.quality!.observations()).map((item) => item.kind)).toEqual(['found', 'claimed_fixed', 'overridden'])
  const claimed = (await stores.quality!.observations())[1]!
  expect(claimed.invocationId).toBeUndefined()
})

it('只精确去重同评审者同 key，跨轮保留调用事实，不按相似文本或其他评审者合并', async () => {
  const { stores, result, sync } = await fixture([node('review'), node('other')])
  await result(1, [issue(), issue('ISS-1', 'duplicate'), issue('ISS-2', '2')])
  await result(2, [issue()], [{ key: 'ISS-1', status: 'still_open' }])
  await result(1, [issue()], undefined, 'second')
  await result(1, [issue()], undefined, 'reviewer', 'other')
  await result(3, [], [{ key: 'ISS-2', status: 'resolved' }], 'second')
  await sync()
  const items = await stores.quality!.observations()
  expect(items.filter((item) => item.kind === 'found')).toHaveLength(5)
  expect(items.filter((item) => item.kind === 'still_open')).toHaveLength(1)
  expect(items.filter((item) => item.kind === 'verified_fixed')).toHaveLength(0)
  expect(await stores.quality!.defects()).toEqual([])
})

it('declined 与 deferred 保留观察；耗尽本身和拒绝不放行，人工放行只覆盖未解决问题', async () => {
  const { stores, event, result, sync } = await fixture()
  await result(1, [issue(), issue('ISS-2', '2'), issue('ISS-3', '3')])
  await event('review.response', { round: 1, responses: [
    { round: 1, reviewer: 'reviewer', issueId: '1', action: 'declined', note: '不采纳' },
    { round: 1, reviewer: 'reviewer', issueId: '2', action: 'deferred', note: '延期' },
  ], revised: [] })
  await result(2, [], [{ key: 'ISS-3', status: 'resolved' }])
  await event('review.exhausted', { rounds: 2, action: 'human' })
  await event('human.requested', { requestId: 'decision', ask: '裁决', form: 'choice', choices: ['放行', '终止'] })
  await sync()
  expect((await stores.quality!.observations()).some((item) => item.kind === 'overridden')).toBe(false)
  await event('human.answered', { requestId: 'decision', decision: 'choice', answer: '放行' }, 'review', { type: 'human', id: 'alice', via: 'web' })
  await sync()
  expect((await stores.quality!.observations()).map((item) => item.kind)).toEqual(['found', 'found', 'found', 'declined', 'still_open', 'verified_fixed', 'overridden', 'overridden'])
})

it('代码评审、judge/gate 不入一期观察；loop 文档评审使用完整节点身份', async () => {
  const { stores, result, event, sync } = await fixture([node('code', { code: { repo: 'app' } }), { id: 'loop', kind: 'loop', title: 'loop', needs: [], body: [node('review')] }])
  await result(1, [issue()], undefined, 'reviewer', 'code')
  await event('gate.result', { pass: false, checks: [] }, 'gate')
  await result(1, [issue()], undefined, 'reviewer', 'loop/review')
  await sync()
  expect(await stores.quality!.observations()).toEqual([expect.objectContaining({ nodeId: 'loop/review', issueKey: 'ISS-1' })])
})

it('不相信超前游标缓存，源日志篡改则不推进质量游标', async () => {
  const { stores, result, sync } = await fixture()
  await result(1, [issue()]); await sync()
  await writeFile(join(stores.taktDir, 'quality/cursors.json'), JSON.stringify({ seq: 999999 }))
  expect(await sync()).toMatchObject({ seq: 2, observations: 0 })
  const log = await stores.quality!.read()
  await writeFile(join(stores.taktDir, 'runs/run-1/events.jsonl'), 'corrupt\n')
  await expect(sync()).rejects.toThrow('源运行日志校验失败')
  expect(await stores.quality!.read()).toEqual(log)
})
