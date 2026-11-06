import type { RequirementSummary, RunDetail } from '../api.js'
import type { RunState } from '../types.js'

export function currentNode(run: RunState, graph: RunDetail['graph']): RequirementSummary['current'] {
  const active = graph.nodes.filter(node => ['running', 'waiting_human'].includes(run.nodes[node.id]?.status ?? node.status))
  // 优先呈现需要人决策的叶节点，而不是包住它的 loop / planner。
  const leaf = active.filter(node => !active.some(other => other.parent === node.id))
  const node = leaf.find(node => (run.nodes[node.id]?.status ?? node.status) === 'waiting_human') ?? leaf[0]
  return node ? { runId: run.runId, nodeId: node.id, title: node.title, status: run.nodes[node.id]?.status ?? node.status } : undefined
}
