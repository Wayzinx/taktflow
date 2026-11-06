import { afterEach, beforeEach, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initProject } from '../store/project.js'
import type { ProjectStores } from '../interfaces.js'
import type { EventEnvelope, EventPayloads, EventType, ReviewRound } from '../types.js'
import { qualityMetrics } from './quality.js'
import { createInsights } from './fs-insights.js'

let root: string
let stores: ProjectStores
let events: EventEnvelope[]
const actor = { type: 'system', id: 'test' } as const
const requirementId = 'REQ-1'
const at = '2026-11-06T00:00:00.000Z'
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'takt-quality-'))
  stores = await initProject(root)
  await stores.workspaces.createRequirement({ id: requirementId, title: 'test' })
  events = []
})
afterEach(async () => { await rm(root, { recursive: true, force: true }) })
function event<T extends EventType>(type: T, data: EventPayloads[T], runId = 'run-1') {
  events.push({ type, data, runId, seq: events.length + 1, nodeId: 'review', actor, ts: at, hash: '', prevHash: '' })
}
async function review(path: string, patch: Partial<ReviewRound> = {}, runId = 'run-1') {
  const round: ReviewRound = { round: 1, passed: false, records: [{ round: 1, reviewer: 'qa', verdict: 'request_changes', summary: '', at, artifacts: [], issues: [
    { id: 'a', severity: 'blocker', description: 'a' }, { id: 'b', severity: 'major', description: 'b' }, { id: 'c', severity: 'minor', description: 'c' }, { id: 'd', severity: 'nit', description: 'd' },
  ] }], responses: [], revised: [], ...patch }
  return stores.workspaces.writeArtifact({ ref: { workspace: requirementId, path }, content: JSON.stringify(round), kind: 'review', author: actor, producedBy: { runId, nodeId: 'review' } })
}
const workspace = () => ({ store: stores.workspaces, requirementId })

it('逐检查计已校验，拦截分五类；修订与旧格式兼容，作者回应版本不重复计数', async () => {
  event('gate.result', { pass: false, checks: [{ id: 'a', pass: true }, { id: 'b', pass: false }, { id: 'c', pass: true }] })
  event('review.round', { round: 1, passed: true, verdicts: [] })
  event('review.round', { round: 2, passed: false, verdicts: [] })
  event('judge.verdict', { verdicts: [
    { subject: 'a', category: 'product_bug', confidence: 1, rationale: '', evidence: [] },
    { subject: 'b', category: 'script_defect', confidence: 1, rationale: '', evidence: [] },
  ], routed: [] })
  event('node.checks', { checks: [], unmet: ['c1', 'c2'] })
  event('node.checks', { checks: [], unmet: [] })
  event('retry.suppressed', { fingerprint: 'abc', count: 2, code: 'error', reason: 'same failure' })
  await review('reviews/review/r1-round-1.json', { revision: 1 })
  await review('reviews/review/r1-round-1.json', { revision: 1, responses: [{ round: 1, reviewer: 'qa', issueId: 'a', action: 'fixed', note: '修复完成' }] })
  await review('reviews/review/round-2.json', { round: 2 })
  await review('reviews/review/r2-round-1.json', { revision: 2, passed: true })
  await review('reviews/review/r3-round-1.json', { revision: 3 }, 'other-run')
  expect(await qualityMetrics(events, workspace())).toEqual({ verified: 3, intercepted: 8, interceptedBy: { gate: 1, review: 4, judge: 1, completion: 1, fingerprint: 1 } })
})

it('旧文件重做覆盖为新版本时保留历史轮，别的运行复用相同路径不串账', async () => {
  event('review.round', { round: 1, passed: false, verdicts: [] })
  await review('reviews/review/round-1.json')
  const second: ReviewRound['records'] = [{ round: 1, reviewer: 'qa', verdict: 'request_changes', at: '2026-11-06T01:00:00.000Z', summary: '', artifacts: [], issues: [{ id: 'new', severity: 'major', description: 'later' }] }]
  await review('reviews/review/round-1.json', { records: second })
  await review('reviews/review/round-1.json', { records: second, responses: [{ round: 1, reviewer: 'qa', issueId: 'new', action: 'fixed', note: 'done' }] })
  await review('reviews/review/round-1.json', { records: [{ ...second[0]!, at: '2026-11-06T02:00:00.000Z' }] }, 'run-2')
  expect((await qualityMetrics(events, workspace())).interceptedBy.review).toBe(3)
})

it('空运行不给假通过；损坏的已登记评审给出错误', async () => {
  expect(await qualityMetrics([], workspace())).toEqual({ verified: 0, intercepted: 0, interceptedBy: { gate: 0, review: 0, judge: 0, completion: 0, fingerprint: 0 } })
  await stores.workspaces.writeArtifact({ ref: { workspace: requirementId, path: 'reviews/review/r1-round-1.json' }, content: '{', kind: 'review', author: actor, producedBy: { runId: 'run-1', nodeId: 'review' } })
  event('review.round', { round: 1, passed: false, verdicts: [] })
  await expect(qualityMetrics(events, workspace())).rejects.toThrow('无法解析评审记录')
})

it('RequirementMetrics 聚合多个运行而不重复计算公共存放区的评审', async () => {
  for (const runId of ['run-1', 'run-2']) {
    await stores.runs.create({ runId, workflowId: 'test', workflowVersion: '1', requirementId, status: 'succeeded', startedAt: at, args: {}, nodes: {}, expansions: [] }, { id: 'test', title: '', version: '1', stages: [], nodes: [] })
    await stores.events.append(runId, { type: 'gate.result', actor, data: { pass: true, checks: [{ id: 'test', pass: true }] } })
    await review(`reviews/review/${runId === 'run-1' ? 'r1' : 'r2'}-round-1.json`, { revision: runId === 'run-1' ? 1 : 2 }, runId)
  }
  expect((await createInsights(stores).metrics(requirementId)).quality).toMatchObject({ verified: 2, intercepted: 4, interceptedBy: { review: 4 } })
})
