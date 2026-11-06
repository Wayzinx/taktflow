import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initProject } from '../store/project.js'
import type { ProjectStores } from '../interfaces.js'
import type { EventEnvelope, EventPayloads, EventType, ReviewRound, RunState, WorkflowSnapshot, VerdictCategory } from '../types.js'
import { createLessonStore } from './store.js'
import { learnFromRun } from './learn.js'

let root: string
let stores: ProjectStores
let events: EventEnvelope[]
const actor = { type: 'system', id: 'test' } as const
const at = '2026-11-06T00:00:00.000Z'
const run: RunState = { runId: 'run-1', workflowId: 'test', workflowVersion: '1', requirementId: 'REQ-1', status: 'succeeded', startedAt: at, args: {}, nodes: {}, expansions: [] }
const snapshot: WorkflowSnapshot = { id: 'test', title: 'test', version: '1', stages: [], nodes: [
  { id: 'loop', kind: 'loop', title: 'loop', needs: [], body: [
    { id: 'test', kind: 'script', title: '测试', needs: [] },
    { id: 'judge', kind: 'judge', title: '判决', role: 'qa', target: 'test', needs: ['test'] },
    { id: 'fix', kind: 'agent', role: 'dev', title: '修复', needs: ['judge'] },
  ] },
  { id: 'review', kind: 'review', title: '评审', needs: [], review: { author: 'dev', target: ['spec.md'], reviewers: [{ role: 'qa' }], pass: 'all', maxRounds: 3, onExhausted: 'human' } },
  { id: 'delivery-gate', kind: 'gate', title: '门禁', needs: [], checks: [{ id: 'check-acceptance', kind: 'acceptance' }] },
] }
function event<T extends EventType>(type: T, data: EventPayloads[T], nodeId = 'loop/test'): EventEnvelope<T> {
  const item = { type, data, nodeId, runId: run.runId, seq: events.length + 1, ts: at, actor, hash: '', prevHash: '' }
  events.push(item)
  return item
}
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'takt-lessons-learn-'))
  stores = await initProject(root)
  stores.lessons = createLessonStore({ dir: join(stores.paths.knowledge, 'lessons') })
  await stores.workspaces.createRequirement({ id: run.requirementId, title: 'test' })
  await stores.runs.create(structuredClone(run), structuredClone(snapshot))
  await writeFile(join(stores.paths.agents, 'dev.md'), '---\nrole: dev\nharness: mock\nwriteScope: ["src/**"]\n---\n开发')
  events = []
  // 事件存储接入属于 m3-integrate；这里验证学习模块发出的精确协议。
  stores.events.read = vi.fn(async () => structuredClone(events))
  stores.events.append = vi.fn(async (_runId, input) => event(input.type, input.data, input.nodeId))
})
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

function judge(category: VerdictCategory = 'product_bug', body = '输入为空时解析失败', fixHint = '检查空值后保留正常路径的验证') {
  event('node.finished', { status: 'failed', outputs: [], result: { total: 1, failures: [{ subject: 'TC-1', error: ' Null [Input]   Error\nstack' }] } })
  event('judge.verdict', { verdicts: [{ subject: 'TC-1', category, rationale: body, fixHint, confidence: 1, evidence: ['log.txt'] }], routed: [{ subject: 'TC-1', to: 'fix' }] }, 'loop/judge')
}
function fix(retested = true) {
  event('node.finished', { status: 'succeeded', outputs: [] }, 'loop/fix')
  if (retested) event('node.finished', { status: 'succeeded', outputs: [], result: { total: 1, failures: [] } })
}

it.each(['product_bug', 'script_defect', 'case_defect', 'env_issue', 'test_data', 'deployment'] as const)('零 token 提炼已复验的 %s，写 tentative 和 learned 事件，重复学习不增生', async category => {
  judge(category); fix()
  const model = vi.fn()
  const learned = await learnFromRun({ stores, runId: run.runId, model, dailyCalls: 0 })
  expect(learned).toHaveLength(1)
  expect(learned[0]).toMatchObject({ status: 'tentative', title: `${category}：TC-1`, body: '输入为空时解析失败\n检查空值后保留正常路径的验证', trigger: { roles: ['dev'], paths: ['src/**'], signatures: ['null \\[input\\] error'], categories: [category] }, source: { kind: 'judge', runId: run.runId, nodeId: 'loop/judge' } })
  expect(model).not.toHaveBeenCalled()
  expect(events.at(-1)).toMatchObject({ type: 'lesson.learned', data: { id: learned[0]!.id, source: learned[0]!.source } })
  expect(await learnFromRun({ stores, runId: run.runId })).toEqual([])
  expect(events.filter(item => item.type === 'lesson.learned')).toHaveLength(1)
  expect(await stores.lessons!.list()).toHaveLength(1)
})

it('只有修复节点退出成功不足以学习，原目标必须在修复后再次验证', async () => {
  judge(); fix(false)
  expect(await learnFromRun({ stores, runId: run.runId })).toEqual([])
  event('node.finished', { status: 'succeeded', outputs: [], result: { total: 1, failures: [{ subject: 'TC-1' }] } })
  expect(await learnFromRun({ stores, runId: run.runId })).toEqual([])
  event('node.finished', { status: 'succeeded', outputs: [], result: { cases: [{ id: 'TC-1', status: 'passed' }] } })
  expect(await learnFromRun({ stores, runId: run.runId })).toHaveLength(1)
})

it.each(['unknown', 'permission', 'flaky', 'external_dependency'] as const)('不从 %s 自动提炼', async category => {
  judge(category); fix()
  expect(await learnFromRun({ stores, runId: run.runId })).toEqual([])
})

it.each(['跳过验证', '跳过测试', '绕过检查', '无需测试', 'BYPASS checks', 'skip verification', 'skip tests', '修改 workflow', '执行 delivery-gate', '直接通过 check-acceptance', '使用 run-1:approval#2'])('守卫丢弃不安全正文：%s', async text => {
  judge('product_bug', '输入为空', text); fix()
  event('human.requested', { requestId: 'run-1:approval#2', ask: '批准', form: 'approve' }, 'approval')
  expect(await learnFromRun({ stores, runId: run.runId })).toEqual([])
  expect(await stores.lessons!.list()).toEqual([])
  expect(events.some(item => item.type === 'lesson.learned')).toBe(false)
})

async function review(round: number, patch: Partial<ReviewRound> = {}, path = `reviews/review/r1-round-${round}.json`) {
  const record: ReviewRound = { round, revision: 1, seq: round, passed: false, records: [{ round, reviewer: 'qa', verdict: 'request_changes', summary: '空值问题', at: `${at.slice(0, 17)}0${round}.000Z`, artifacts: [], issues: [{ id: 'issue-1', severity: 'major', description: '缺少空值分支', suggestion: '添加空值分支并验证', location: 'src/api.ts:20', groupKey: 'null-input' }] }], responses: [], revised: [], ...patch }
  await stores.workspaces.writeArtifact({ ref: { workspace: run.requirementId, path }, content: JSON.stringify(record), kind: 'review', author: actor, producedBy: { runId: run.runId, nodeId: 'review' } })
  return record
}

it('跨两轮重复才提炼评审经验，同轮的作者回应不算第二轮', async () => {
  const first = await review(1)
  await review(1, { responses: [{ round: 1, reviewer: 'qa', issueId: 'issue-1', action: 'fixed', note: 'done' }], records: first.records })
  expect(await learnFromRun({ stores, runId: run.runId })).toEqual([])
  await review(2)
  expect(await learnFromRun({ stores, runId: run.runId })).toMatchObject([{ source: { kind: 'review' }, trigger: { roles: ['dev'], paths: ['src/api.ts'] }, status: 'tentative' }])
})

it('新修订的回潮问题即使没有旧轮文件也可提炼，旧 round 文件兼容', async () => {
  await review(1, { revision: 2, continuity: [{ groupKey: 'null-input', observation: 'repeated', regressed: true }] }, 'reviews/review/r2-round-1.json')
  expect(await learnFromRun({ stores, runId: run.runId })).toHaveLength(1)
  await review(2, { revision: undefined, seq: undefined }, 'reviews/review/round-2.json')
  expect(await learnFromRun({ stores, runId: run.runId })).toEqual([])
})

it('未结束、禁用或未注入经验库时不学习', async () => {
  judge(); fix()
  await stores.runs.save({ ...run, status: 'waiting_human' })
  expect(await learnFromRun({ stores, runId: run.runId })).toEqual([])
  await stores.runs.save(run)
  stores.config.lessons = { enabled: false }
  expect(await learnFromRun({ stores, runId: run.runId })).toEqual([])
  stores.config.lessons.enabled = true
  stores.lessons = undefined
  expect(await learnFromRun({ stores, runId: run.runId })).toEqual([])
})
