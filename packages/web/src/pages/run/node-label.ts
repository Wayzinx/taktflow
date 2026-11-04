import type { Expansion, GraphNode } from '@taktflow/core'

export interface NodeLabel {
  title: string
  /** 第二行的补充说明；为空时用角色 / 节点类型。 */
  sub?: string
}

/**
 * 节点在画布和抽屉里显示的名字。
 * planner 展开节点的定义不进快照，server 只能拿 id 拼一个兜底标题（"<id>（展开节点…）"），
 * 这时改用规划条目的标题 + 模板步骤名，id 照样在 tooltip / 抽屉副标题里能看到。
 */
export function nodeLabel(node: Pick<GraphNode, 'id' | 'title' | 'parent'>, expansions: Expansion[]): NodeLabel {
  if (!node.parent || !node.title.startsWith(node.id)) return { title: node.title }
  const exp = expansions.find((e) => e.plannerId === node.parent && e.nodeIds.includes(node.id))
  if (!exp) return { title: node.title }
  const [key, ...step] = node.id.slice(exp.plannerId.length + 1).split('/')
  const item = exp.items.find((i) => i.key === key)
  if (!item) return { title: node.title }
  return { title: item.title, sub: step.join('/') || item.key }
}
