import { useEffect } from 'react'
import { Panel, ViewportPortal, useNodes, useReactFlow } from '@xyflow/react'
import { Eye, MessagesSquare, Minus, PenLine, Plus, X } from 'lucide-react'
import { prefersReducedMotion } from '../../../lib/motion'
import { openSteward, previewWorkflowProposal, type WorkflowPreview } from '../../../lib/ui-store'
import { ghostEdits, layoutGhost, type Box } from './ghost-edits'
import './ghost-overlay.css'

/**
 * workflow 提案的画布幽灵预览（docs/design/22 §1.5）：新增节点绿色虚线框 + 新依赖绿色虚线、删除节点红色划线、
 * 去掉的依赖红色虚线、改动节点琥珀色角标。摆位规则见 ghost-edits.ts layoutGhost。
 * 挂载：canvas/workflow-canvas.tsx 在 <ReactFlow> 内部渲染，由 WorkflowCanvasProps.ghost 传入（提案卡 previewWorkflowProposal() 写入）。
 * 位置取 React Flow 的绝对坐标（loop 内子节点也对），随画布平移缩放（ViewportPortal）。
 */
export function GhostOverlay({ preview }: { preview: WorkflowPreview }) {
  useNodes() // 节点移动 / 测量后重算
  const rf = useReactFlow()
  const edits = ghostEdits(preview)
  const boxOf = (id: string): Box | undefined => {
    const n = rf.getInternalNode(id)
    if (!n) return undefined
    const p = n.internals.positionAbsolute
    return { x: p.x, y: p.y, w: n.measured.width ?? 220, h: n.measured.height ?? 64 }
  }
  const needsOf = (id: string) => rf.getEdges().filter((e) => e.target === id && (e.data as { kind?: string } | undefined)?.kind === 'need').map((e) => e.source)
  const { added, removed, changed, links } = layoutGhost(edits, boxOf, needsOf)
  const total = added.length + removed.length + changed.size

  // 打开预览时把涉及的节点带进视野（只在提案切换时做一次）
  const focusIds = edits.flatMap((e) => ('id' in e && typeof e.id === 'string' ? [e.id] : e.op === 'addNode' && e.after ? [e.after] : []))
  const focusKey = `${preview.proposalId}:${focusIds.join(',')}`
  useEffect(() => {
    if (!focusIds.length) return
    const t = setTimeout(() => void rf.fitView({ nodes: focusIds.map((id) => ({ id })), padding: 0.6, maxZoom: 1, duration: prefersReducedMotion() ? 0 : 200 }), 60)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusKey])

  return (
    <>
      <ViewportPortal>
        {links.length > 0 && (
          <svg className="ghost-links" aria-hidden>
            <defs>
              <marker id="ghost-arrow-add" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                <path d="M0,0 L10,5 L0,10 z" />
              </marker>
            </defs>
            {links.map((l) => (
              <g key={l.key} data-tone={l.tone}>
                <path d={l.path} markerEnd={l.tone === 'add' ? 'url(#ghost-arrow-add)' : undefined} />
                {l.tone === 'del' && <path className="ghost-x" d={`M${l.mid.x - 5},${l.mid.y - 5} l10,10 m0,-10 l-10,10`} />}
              </g>
            ))}
          </svg>
        )}
        {added.map((a) => (
          <div key={a.key} className="ghost-node ghost-add" style={{ left: a.box.x, top: a.box.y, width: a.box.w, height: a.box.h }}>
            <span className="ghost-badge">
              <Plus aria-hidden />
              新增
            </span>
            <span className="ghost-title">{a.title}</span>
            <span className="ghost-kind mono">{a.kind}</span>
          </div>
        ))}
        {removed.map((r) => (
          <div key={r.id} className="ghost-node ghost-del" style={{ left: r.box.x, top: r.box.y, width: r.box.w, height: r.box.h }}>
            <span className="ghost-badge">
              <Minus aria-hidden />
              删除
            </span>
          </div>
        ))}
        {[...changed].map(([id, c]) => (
          <div key={id} className="ghost-node ghost-mod" style={{ left: c.box.x, top: c.box.y, width: c.box.w, height: c.box.h }} title={`改动：${c.keys.join('、')}`}>
            <span className="ghost-badge">
              <PenLine aria-hidden />
              {c.keys.slice(0, 2).join('、')}
              {c.keys.length > 2 ? ` 等 ${c.keys.length} 处` : ''}
            </span>
          </div>
        ))}
      </ViewportPortal>
      <Panel position="top-center" className="ghost-panel">
        <div className="ghost-bar" role="status">
          <Eye aria-hidden />
          <span className="ghost-bar-title truncate">预览提案：{preview.step.title ?? `${total} 处改动`}</span>
          <span className="ghost-legend">
            {added.length > 0 && <span data-k="add">+{added.length} 新增</span>}
            {changed.size > 0 && <span data-k="mod">{changed.size} 改动</span>}
            {removed.length > 0 && <span data-k="del">-{removed.length} 删除</span>}
          </span>
          <button type="button" className="btn btn-sm" onClick={() => openStewardFor(preview)}>
            <MessagesSquare />
            去决定
          </button>
          <button type="button" className="btn btn-ghost btn-icon btn-sm" aria-label="关闭预览" title="关闭预览" onClick={() => previewWorkflowProposal(undefined)}>
            <X />
          </button>
        </div>
      </Panel>
    </>
  )
}

/** 打开提案所在的会话（停靠面板）。 */
function openStewardFor(p: WorkflowPreview) {
  openSteward({ threadId: p.threadId, context: [{ type: 'workflow', id: p.workflowId, label: p.workflowId }] })
}
