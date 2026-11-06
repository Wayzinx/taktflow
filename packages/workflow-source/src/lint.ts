import type { EditableNode, EditableValue, EditableWorkflow, WorkflowDiagnostic } from '@taktflow/core'

const value = (field?: EditableValue): unknown => field?.kind === 'literal' ? field.value : undefined
const object = (entry: unknown): Record<string, unknown> => entry !== null && typeof entry === 'object' && !Array.isArray(entry) ? entry as Record<string, unknown> : {}
const flatten = (nodes: EditableNode[]): EditableNode[] => nodes.flatMap((node) => [node, ...flatten(node.body ?? [])])

export function lintModel(model: EditableWorkflow): WorkflowDiagnostic[] {
  const diagnostics: WorkflowDiagnostic[] = []
  const report = (severity: WorkflowDiagnostic['severity'], message: string, nodeId?: string) => diagnostics.push({ severity, message, nodeId })
  const tiers = value(model.meta.tiers)
  if (model.meta.tiers?.kind === 'literal' && (!Array.isArray(tiers) || tiers.some((tier) => !['T0', 'T1', 'T2', 'T3'].includes(tier)))) report('error', 'tiers 只能包含 T0、T1、T2、T3')
  const nodes = flatten(model.nodes)
  const byId = new Map(nodes.map((node) => [node.id, node]))
  function upstream(node: EditableNode, seen = new Set<string>()): EditableNode[] {
    const needs = value(node.props.needs)
    if (!Array.isArray(needs)) return []
    return needs.flatMap((id) => {
      const parent = byId.get(id)
      if (!parent || seen.has(id)) return []
      seen.add(id)
      return [parent, ...upstream(parent, seen)]
    })
  }
  for (const node of nodes) {
    if (node.kind === 'review') {
      const author = object(value(node.props.author)).role
      const reviewers = value(node.props.reviewers)
      const roles = [...(Array.isArray(reviewers) ? reviewers.map((reviewer) => object(reviewer).role) : []), object(value(node.props.arbiter)).role]
      if (typeof author === 'string' && roles.includes(author)) report('error', '评审者不能是作者角色（含 arbiter）', node.id)
    }
    if (node.kind === 'gate') {
      const checks = value(node.props.checks)
      const authors = upstream(node).filter((parent) => parent.kind === 'agent').map((parent) => value(parent.props.role))
      if (Array.isArray(checks)) for (const entry of checks) {
        const check = object(entry)
        if (check.kind === 'rubric' && typeof check.role === 'string' && authors.includes(check.role)) report('warning', `rubric 门禁 ${String(check.id)} 的评审角色与上游产出角色相同`, node.id)
      }
    }
    const completion = value(node.props.completion)
    if (node.kind === 'agent' && Array.isArray(completion) && completion.some((criterion) => typeof criterion === 'string' && [...criterion.trim()].length < 6)) report('warning', '完成标准少于 6 个字，请写成可验证的条件', node.id)
  }
  return diagnostics
}
