import { useState } from 'react'
import { GripVertical, Lock } from 'lucide-react'
import { KindIcon } from '../../../components/ui'
import { stagesOf } from '../canvas/graph'
import type { WorkflowDocState } from '../state'
import { addNode, type Placement } from './add-node'
import { DRAG_MIME, PALETTE, type PaletteItem } from './node-defaults'
import { ReviewWizard } from './review-wizard'
import './palette.css'

/**
 * 左侧节点面板：拖到画布的泳道 / loop 框里新增节点（画布 onDrop 处理位置），
 * 也可以点击或回车加到下方选中的阶段末尾（键盘可达）。review 节点一律走配置向导。
 */
export function NodePalette({ wf, onSelect }: { wf: WorkflowDocState; onSelect?: (id: string) => void }) {
  const stages = wf.model ? stagesOf(wf.model) : []
  const [stage, setStage] = useState<string>()
  const [wizard, setWizard] = useState<Placement>()
  const target = stage && stages.some((s) => s.id === stage) ? stage : stages[0]?.id
  const disabled = wf.readOnly || !wf.model || wf.status === 'conflict'

  function add(item: PaletteItem) {
    if (disabled) return
    const at: Placement = { stage: target }
    if (item.kind === 'review') return setWizard(at)
    void addNode(wf, item.kind, item.defaults(), at).then((id) => id && onSelect?.(id))
  }

  return (
    <aside className="wf-palette card" aria-label="节点面板">
      <div className="wf-pane-head">
        <span className="section-label">节点</span>
      </div>
      {wf.readOnly ? (
        <p className="wf-palette-note">
          <Lock />
          只读流水线，不能新增节点
        </p>
      ) : (
        <p className="wf-palette-note wf-palette-how">拖到画布的阶段泳道或 Loop 框中；点击则加到所选阶段末尾。</p>
      )}
      <ul className="wf-palette-list">
        {PALETTE.map((item) => (
          <li key={item.kind}>
            <button
              className="wf-palette-item"
              draggable={!disabled}
              disabled={disabled}
              onDragStart={(e) => {
                e.dataTransfer.setData(DRAG_MIME, item.kind)
                e.dataTransfer.effectAllowed = 'copy'
              }}
              onClick={() => add(item)}
              title={`${item.hint}。${item.kind === 'review' ? '点击打开评审节点配置向导' : `点击新增${item.label}节点`}`}
            >
              <KindIcon kind={item.kind} size={24} />
              <span className="wf-palette-text">
                <span className="wf-palette-label">{item.label}</span>
                <span className="wf-palette-hint">{item.hint}</span>
              </span>
              <GripVertical className="wf-palette-grip" aria-hidden />
            </button>
          </li>
        ))}
      </ul>
      {stages.length > 0 && (
        <label className="wf-palette-stage">
          <span className="section-label">点击添加到</span>
          <select className="select" value={target} onChange={(e) => setStage(e.target.value)} disabled={disabled}>
            {stages.map((s) => (
              <option key={s.id} value={s.id}>{s.title}</option>
            ))}
          </select>
        </label>
      )}
      {wizard && <ReviewWizard wf={wf} placement={wizard} onClose={() => setWizard(undefined)} onDone={onSelect} />}
    </aside>
  )
}
