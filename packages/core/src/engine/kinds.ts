import type { NodeDef, NodeKind } from '../types.js'

/**
 * 引擎真正实现的节点类型。协议里的 review / subflow 还没有实现，
 * 必须在启动、恢复和动态展开时拒绝，不能落进 switch 后当成成功。
 */
export const SUPPORTED_NODE_KINDS = ['script', 'agent', 'gate', 'human', 'judge', 'loop', 'planner'] as const

const supported = new Set<NodeKind>(SUPPORTED_NODE_KINDS)

export function assertSupportedNode(node: Pick<NodeDef, 'id' | 'kind'>, prefix = ''): void {
  if (!supported.has(node.kind)) throw new Error(`不支持的节点类型：${node.kind}（节点 ${prefix}${node.id}）`)
}

/** 递归检查 loop 体；planner 展开的节点在 Runtime.add 时逐个检查。 */
export function assertSupportedNodes(nodes: NodeDef[], prefix = ''): void {
  for (const node of nodes) {
    assertSupportedNode(node, prefix)
    if (node.kind === 'loop') assertSupportedNodes(node.body, `${prefix}${node.id}/`)
  }
}
