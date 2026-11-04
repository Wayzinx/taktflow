import type { RunSummary } from '../api.js'
import type { RunState, Usage } from '../types.js'
import { addUsage } from './usage.js'

export function summarizeRun(state: RunState): RunSummary {
  const nodes = Object.values(state.nodes)
  let usage: Usage = { inputTokens: 0, outputTokens: 0 }
  for (const node of nodes) if (node.usage) usage = addUsage(usage, node.usage)
  return {
    runId: state.runId, workflowId: state.workflowId, requirementId: state.requirementId,
    status: state.status, startedAt: state.startedAt, endedAt: state.endedAt,
    progress: {
      total: nodes.length,
      done: nodes.filter((node) => node.status === 'succeeded' || node.status === 'skipped').length,
      failed: nodes.filter((node) => node.status === 'failed' || node.status === 'blocked').length,
    },
    usage,
  }
}
