import type { WorkflowDefinition } from '../types.js'
import { validateDag } from '../engine/graph.js'

export function validateWorkflow(value: unknown): asserts value is WorkflowDefinition {
  const workflow = value as WorkflowDefinition | undefined
  if (!workflow || typeof workflow !== 'object' || typeof workflow.id !== 'string' || !workflow.id.trim()
    || typeof workflow.version !== 'string' || !workflow.version.trim() || typeof workflow.title !== 'string'
    || !Array.isArray(workflow.stages) || !Array.isArray(workflow.nodes)) {
    throw new Error('workflow 需要非空 id/version、字符串 title、stages/nodes 数组')
  }
  const stages = new Set<string>()
  for (const stage of workflow.stages) {
    if (!stage || typeof stage.id !== 'string' || !stage.id.trim() || typeof stage.title !== 'string') throw new Error(`workflow ${workflow.id}: stage 需要 id/title`)
    if (stages.has(stage.id)) throw new Error(`workflow ${workflow.id}: stage ID 重复：${stage.id}`)
    stages.add(stage.id)
  }
  validateDag(workflow.nodes, stages)
}
