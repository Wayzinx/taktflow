import type { EditableValue, NodeKind } from '@taktflow/core'
import { lit } from '../../../api/workflow-edit'
import { NODE_KIND } from '../../../lib/status'
import { freshId, insertAfter, type Pos } from '../canvas/graph'
import type { WorkflowDocState } from '../state'

export interface Placement {
  stage?: string
  /** 放进哪个 loop 的循环体。 */
  parent?: string
  /** 画布上的绝对坐标；缺省时由画布排到泳道最下方。 */
  position?: Pos
}

/** 新增节点：id 自动编号，props 顺序为 id / title / stage / 其余，与手写源码习惯一致。成功返回新 id。 */
export async function addNode(wf: WorkflowDocState, kind: NodeKind, props: Record<string, EditableValue>, at: Placement): Promise<string | undefined> {
  const model = wf.model
  if (!model || wf.readOnly) return undefined
  const id = (props.id?.kind === 'literal' && typeof props.id.value === 'string' && props.id.value) || freshId(model, kind)
  const { id: _id, title, needs, ...rest } = props
  void _id
  const full: Record<string, EditableValue> = {
    id: lit(id),
    title: title ?? lit(`新${NODE_KIND[kind].label}`),
    ...(at.parent || !at.stage ? {} : { stage: lit(at.stage) }),
    ...(needs ? { needs } : {}),
    ...rest,
  }
  if (at.position) wf.saveLayout({ ...(wf.layout ?? { nodes: {} }), nodes: { ...(wf.layout?.nodes ?? {}), [id]: at.position } })
  const ok = await wf.applyEdits([{ op: 'addNode', kind, props: full, after: insertAfter(model, at.stage, at.parent), parent: at.parent }], { reason: `新增${NODE_KIND[kind].label}节点 ${id}` })
  return ok ? id : undefined
}
