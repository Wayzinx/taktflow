import type { NodeDef, WorkflowDefinition } from '../types.js'

/** args.review 提供运行级默认值；args.reviews[nodeId] 可覆盖单个评审，运行快照保存最终配置。 */
export function configureReviews(workflow: WorkflowDefinition, args: Record<string, unknown>): WorkflowDefinition {
  const defaults = (args.review ?? {}) as Record<string, unknown>
  const overrides = (args.reviews ?? {}) as Record<string, Record<string, unknown>>
  const visit = (nodes: NodeDef[]): NodeDef[] => nodes.map((node) => {
    if (node.kind === 'loop') return { ...node, body: visit(node.body) }
    if (node.kind === 'planner') return { ...node, expand: (item) => visit(node.expand(item)) }
    if (node.kind !== 'review') return node
    const options = { ...defaults, ...overrides[node.id] }
    const maxRounds = options.maxRounds ?? node.maxRounds
    const humanSignoff = options.humanSignoff ?? node.humanSignoff
    if (typeof maxRounds !== 'number' || !Number.isInteger(maxRounds) || maxRounds < 1) throw new Error('review.maxRounds 必须是正整数')
    if (humanSignoff !== undefined && typeof humanSignoff !== 'boolean') throw new Error('review.humanSignoff 必须是布尔值')
    let onExhausted = node.onExhausted
    if (typeof onExhausted === 'object') {
      const rework = options.rework ?? onExhausted.rework
      const maxReworks = options.maxReworks ?? onExhausted.maxReworks ?? 1
      if (typeof rework !== 'string' || typeof maxReworks !== 'number' || !Number.isInteger(maxReworks) || maxReworks < 0) throw new Error('review.rework / maxReworks 不合法')
      onExhausted = { rework, maxReworks }
    }
    return { ...node, maxRounds, humanSignoff, onExhausted }
  })
  return { ...workflow, nodes: visit(workflow.nodes) }
}
