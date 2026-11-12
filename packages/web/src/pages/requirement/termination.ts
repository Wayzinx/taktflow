import type { RequirementDetail } from '@taktflow/core'

/**
 * 最近一次流水线运行被人终止（cancelled）时，需求状态仍是 blocked（core 的 deriveRequirementState 语义不动）；
 * 展示上改叫"已终止"，并给出重新启动入口。只有最新一次流水线运行能决定这件事。
 */
export function cancelledRunOf(r: RequirementDetail): { runId: string; endedAt?: string } | undefined {
  if (r.status !== 'blocked' || r.pendingAttention > 0) return undefined
  const run = r.runs.find((x) => x.runId === r.latestRunId)
  return run?.status === 'cancelled' ? { runId: run.runId, endedAt: run.endedAt } : undefined
}
