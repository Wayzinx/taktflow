import { useCallback } from 'react'
import { AlertTriangle, Lock, Settings2, Trash2 } from 'lucide-react'
import type { WorkflowEdit } from '@taktflow/core'
import { findNode } from '../../../api/workflow-edit'
import { KindIcon } from '../../../components/ui'
import { NODE_KIND } from '../../../lib/status'
import { titleOf } from '../canvas/graph'
import type { WorkflowDocState } from '../state'
import { MetaForm } from './meta-form'
import { NodeForm } from './node-form'
import { useRoleOptions } from './options'
import { useDutyOptions } from './owner-fields'
import './properties.css'

/** 右侧属性面板：字面量属性用表单（setProp），代码值显示只读代码块并可切换文本编辑。nodeId 为空时编辑 workflow 元信息与阶段。 */
export function PropertiesPanel({ wf, nodeId }: { wf: WorkflowDocState; nodeId?: string }) {
  const roles = useRoleOptions()
  const duties = useDutyOptions()
  const disabled = wf.readOnly || wf.status === 'conflict'
  const apply = useCallback((edits: WorkflowEdit[], reason: string) => void wf.applyEdits(edits, { reason }), [wf])
  const model = wf.model
  const loc = model && nodeId ? findNode(model.nodes, nodeId) : undefined

  if (!model) return <aside className="wf-properties card" aria-label="属性" />

  const lockNote = disabled && (
    <p className="wf-pane-note">
      <Lock />
      {wf.readOnly ? '只读：可以查看属性，不能修改' : '有未解决的冲突，解决后才能继续编辑'}
    </p>
  )

  if (!loc)
    return (
      <aside className="wf-properties card" aria-label="workflow 属性">
        <div className="wf-pane-head">
          <Settings2 className="wf-pane-icon" />
          <div className="wf-pane-title">
            <span className="section-label">流水线</span>
            <span className="mono faint truncate">{model.meta.id}</span>
          </div>
        </div>
        {lockNote}
        <p className="wf-pane-note">在画布上点选节点以编辑它的属性。</p>
        <MetaForm model={model} disabled={disabled} apply={apply} />
      </aside>
    )

  const node = loc.node
  const t = titleOf(node)
  const diags = (wf.doc?.diagnostics ?? []).filter((d) => d.nodeId === node.id)
  return (
    <aside className="wf-properties card" aria-label={`节点 ${node.id} 的属性`}>
      <div className="wf-pane-head">
        <KindIcon kind={node.kind} size={26} />
        <div className="wf-pane-title">
          <span className={`truncate wf-pane-name${t.code ? ' mono' : ''}`}>{t.text}</span>
          <span className="mono faint truncate">
            {node.id} · {NODE_KIND[node.kind].label}
            {loc.parent ? ` · ${loc.parent.id} 循环体` : ''}
          </span>
        </div>
        {!disabled && (
          <button className="btn btn-ghost btn-sm btn-icon" onClick={() => apply([{ op: 'removeNode', id: node.id }], `删除节点 ${node.id}`)} aria-label={`删除节点 ${node.id}`} title="删除节点（可撤销）">
            <Trash2 />
          </button>
        )}
      </div>
      {lockNote}
      {diags.length > 0 && (
        <ul className="wf-diags">
          {diags.map((d, i) => (
            <li key={i} className={`is-${d.severity}`}>
              <AlertTriangle />
              {d.message}
            </li>
          ))}
        </ul>
      )}
      <NodeForm key={node.id} ctx={{ model, node, disabled, roles, duties, apply }} />
    </aside>
  )
}
