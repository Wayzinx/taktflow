import type { NodeDef, WorkflowDefinition } from '../types.js'

export function configureRepositories(workflow: WorkflowDefinition, args: Record<string, unknown>): WorkflowDefinition {
  if (workflow.id !== 'taktflow-standard' || args.repo === undefined) return workflow
  if (typeof args.repo !== 'string' || !args.repo.trim()) throw new Error('args.repo 必须是非空仓库 ID')
  const repo = args.repo
  const configure = (node: NodeDef): NodeDef => {
    if (node.kind === 'agent' && node.repo === 'app') return { ...node, repo }
    if (node.kind === 'review' && !Array.isArray(node.target) && node.target.code.repo === 'app') return { ...node, target: { code: { ...node.target.code, repo } } }
    if (node.kind === 'loop') return { ...node, body: node.body.map(configure) }
    if (node.kind === 'planner') return { ...node, expand: (item) => node.expand({ ...item, params: { ...item.params, repo: item.params?.repo === undefined || item.params.repo === 'app' ? repo : item.params.repo } }).map(configure) }
    return node
  }
  return { ...workflow, nodes: workflow.nodes.map(configure) }
}
