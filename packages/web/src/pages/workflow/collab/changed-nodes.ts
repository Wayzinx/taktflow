import type { EditableWorkflow } from '@taktflow/core'
import { allNodes } from '../../../api/workflow-edit'

export interface NodeChanges {
  added: string[]
  removed: string[]
  modified: string[]
}

const index = (m: EditableWorkflow) => new Map(allNodes(m.nodes).map((n) => [n.id, JSON.stringify({ kind: n.kind, props: n.props })]))

/** 两版模型之间的节点变化，按新增 / 删除 / 修改分开（loop 体的变化记在子节点上）。 */
export function diffNodes(before: EditableWorkflow | undefined, after: EditableWorkflow | undefined): NodeChanges {
  const out: NodeChanges = { added: [], removed: [], modified: [] }
  if (!before || !after) return out
  const a = index(before)
  const b = index(after)
  for (const [id, v] of b) {
    if (!a.has(id)) out.added.push(id)
    else if (a.get(id) !== v) out.modified.push(id)
  }
  for (const id of a.keys()) if (!b.has(id)) out.removed.push(id)
  return out
}

/** 两版模型之间新增、删除或属性有变化的节点 id（远端变更高亮用）。 */
export function changedNodeIds(before: EditableWorkflow | undefined, after: EditableWorkflow | undefined): string[] {
  const c = diffNodes(before, after)
  return [...c.added, ...c.modified, ...c.removed]
}

/** 源码里每个节点 `id: '…'` 所在的行（1 起），源码视图据此把节点诊断 / 远端变更落到行上。 */
export function nodeLines(source: string): Map<string, number> {
  const out = new Map<string, number>()
  source.split('\n').forEach((line, i) => {
    for (const m of line.matchAll(/\bid:\s*['"]([^'"]+)['"]/g)) if (!out.has(m[1]!)) out.set(m[1]!, i + 1)
  })
  return out
}
