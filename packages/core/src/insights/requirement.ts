import type { RequirementStatus, RunState, WorkflowSnapshot } from '../types.js'
import { buildRunGraph, stageProgress } from './graph.js'

export function deriveRequirementState(snapshot: WorkflowSnapshot, latestRun: RunState): { status: RequirementStatus; stage?: string } {
  const stages = stageProgress(snapshot, latestRun)
  const stage = stages.find((item) => item.status !== 'done')?.id ?? stages.at(-1)?.id
  const nodes = buildRunGraph(snapshot, latestRun).nodes
  if (latestRun.status === 'failed' || latestRun.status === 'cancelled'
    || Object.values(latestRun.nodes).some((node) => ['blocked', 'failed', 'cancelled'].includes(node.status))) return { status: 'blocked', stage }
  // 全跳过、没有最终阶段或只有部分阶段完成都不是交付证据。
  const last = stages.at(-1)
  const finalHumansApproved = nodes.filter((node) => node.stage === last?.id && node.kind === 'human').every((node) => {
    const result = latestRun.nodes[node.id]?.result as { decision?: string; answer?: string } | undefined
    if (node.status !== 'succeeded') return false
    if (result?.decision === 'approve') return true
    if (result?.decision !== undefined && result.decision !== 'choice') return false
    return typeof result?.answer === 'string' && result.answer.trim() !== ''
  })
  const delivered = latestRun.status === 'succeeded' && finalHumansApproved && last?.status === 'done'
    && stages.every((item) => item.status === 'done')
    && nodes.some((node) => node.stage === last.id && node.status === 'succeeded')
  return { status: delivered ? 'delivered' : 'active', stage }
}
