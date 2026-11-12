import { describe, expect, it } from 'vitest'
import type { RunSummary } from '@taktflow/core'
import { latestRun, supersededBy } from './run-context'

const run = (runId: string, startedAt: string, kind: RunSummary['kind'] = 'workflow'): RunSummary => ({
  runId, startedAt, kind, workflowId: 'wf', requirementId: 'REQ-1', status: 'failed',
  progress: { total: 1, done: 0, failed: 1 }, usage: { inputTokens: 0, outputTokens: 0 },
})

describe('运行上下文', () => {
  const old = run('run-1', '2026-11-09T00:00:00Z')
  const newer = run('run-2', '2026-11-10T00:00:00Z')
  const task = run('run-3', '2026-11-11T00:00:00Z', 'task')
  it('最近任意运行包括失败的 Lead 临时任务，且不修改原列表', () => {
    const runs = [task, old, newer]
    expect(latestRun(runs)).toBe(task)
    expect(runs).toEqual([task, old, newer])
    expect(latestRun([])).toBeUndefined()
  })
  it('历史流水线只由后来的流水线取代，临时任务不取代流水线', () => {
    expect(supersededBy([task, old, newer], old)).toBe(newer)
    expect(supersededBy([task, newer], newer)).toBeUndefined()
    expect(supersededBy([old, newer], task)).toBeUndefined()
    expect(supersededBy([old], old)).toBeUndefined()
  })
})
