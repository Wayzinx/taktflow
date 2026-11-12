import { expect, it } from 'vitest'
import type { RequirementDetail, RunSummary } from '@taktflow/core'
import { cancelledRunOf } from './termination'

const run = (runId: string, status: RunSummary['status']): RunSummary => ({
  runId,
  workflowId: 'w',
  requirementId: 'REQ-1',
  status,
  startedAt: '',
  progress: { done: 0, total: 1, failed: 0 },
  usage: { inputTokens: 0, outputTokens: 0 },
})

const req = (patch: Partial<RequirementDetail>): RequirementDetail =>
  ({ id: 'REQ-1', title: 't', status: 'blocked', links: [], createdAt: '', updatedAt: '', stages: [], pendingAttention: 0, usage: { inputTokens: 0, outputTokens: 0 }, artifacts: [], runs: [], ...patch }) as RequirementDetail

it('最新一次流水线运行被人工终止时，展示成“已终止”（TF-063）', () => {
  const r = req({ latestRunId: 'run-2', runs: [run('run-1', 'succeeded'), { ...run('run-2', 'cancelled'), endedAt: '2026-11-11T10:00:00Z' }] })
  expect(cancelledRunOf(r)).toEqual({ runId: 'run-2', endedAt: '2026-11-11T10:00:00Z' })
})

it('失败、仍有待办、或最新运行不是取消时不改文案（TF-063）', () => {
  expect(cancelledRunOf(req({ latestRunId: 'run-2', runs: [run('run-2', 'failed')] }))).toBeUndefined()
  expect(cancelledRunOf(req({ latestRunId: 'run-2', pendingAttention: 1, runs: [run('run-2', 'cancelled')] }))).toBeUndefined()
  expect(cancelledRunOf(req({ latestRunId: 'run-2', runs: [run('run-2', 'cancelled')], status: 'active' }))).toBeUndefined()
  // 旧运行取消、最新一次正常时不能误判
  expect(cancelledRunOf(req({ latestRunId: 'run-2', runs: [run('run-1', 'cancelled'), run('run-2', 'failed')] }))).toBeUndefined()
})
