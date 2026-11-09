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
  // acceptance 检查逐条 AC 要求用例（cases/*.json）和执行结果（evidence/summary.json）；流程里没有节点产出它们时，
  // 这条交付校验永远过不了（真实事故：裁掉测分与跑用例后保留了交付校验）。产出位置看不清（非字面量 outputs、
  // planner / subflow 动态展开）时不判断。
  const produced = (pattern: RegExp): boolean | undefined => {
    let unknown = false
    for (const candidate of nodes) {
      if (candidate.kind === 'planner' || candidate.kind === 'subflow') unknown = true
      if (candidate.props.outputs === undefined) continue
      const outputs = value(candidate.props.outputs)
      if (!Array.isArray(outputs)) { unknown = true; continue }
      if (outputs.some((output) => typeof object(output).path === 'string' && pattern.test(object(output).path as string))) return true
    }
    return unknown ? undefined : false
  }
  const acceptanceInputs = (gate: EditableNode) => {
    const checks = value(gate.props.checks)
    if (!Array.isArray(checks) || !checks.some((entry) => object(entry).kind === 'acceptance')) return
    const missing = [
      ...(produced(/^cases\//) === false ? ['用例 cases/*.json'] : []),
      ...(produced(/^evidence\//) === false ? ['执行结果 evidence/summary.json'] : []),
    ]
    if (missing.length > 0) {
      report('error', `交付校验的 acceptance 检查要求每条 AC 都有用例和通过的执行结果，但流程里没有节点产出${missing.join('、')}，这条校验永远不会通过；加上测分与跑用例节点（参考 taktflow-standard 的 test-design / automate / run-cases），或经用户同意去掉这条检查`, gate.id)
    }
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
    if (node.kind === 'gate') acceptanceInputs(node)
    const completion = value(node.props.completion)
    if (node.kind === 'agent' && Array.isArray(completion) && completion.some((criterion) => typeof criterion === 'string' && [...criterion.trim()].length < 6)) report('warning', '完成标准少于 6 个字，请写成可验证的条件', node.id)
  }
  return diagnostics
}
