import type { CSSProperties } from 'react'
import { BaseEdge, EdgeLabelRenderer, getSmoothStepPath, useReactFlow, type EdgeProps } from '@xyflow/react'
import { prefersReducedMotion } from '../../../lib/motion'
import { X } from 'lucide-react'
import type { EditorEdge } from './build-flow'

/**
 * 编辑器的边：need 是依赖（可选中、可删），route 是判决路由，rework 是评审打回（都只读，样式区分）。
 * 删除走 React Flow 的 deleteElements，最终落到画布的 onEdgesDelete → setNeeds。
 */
export function WfEdgeView(props: EdgeProps<EditorEdge>) {
  const { id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data, markerEnd, label, selected } = props
  const kind = data?.kind ?? 'need'
  const [path, lx, ly] = getSmoothStepPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, offset: kind === 'rework' ? 36 : 20, borderRadius: 10 })
  const rf = useReactFlow()
  const removable = kind === 'need' && !data?.readOnly && selected
  return (
    <>
      <BaseEdge path={path} markerEnd={markerEnd} className={`wf-edge e-${kind}${selected ? ' is-selected' : ''}`} interactionWidth={kind === 'need' ? 18 : 0} />
      {/* 动效覆盖层（docs/design/27 §2.1）：入场信号从左到右扫过；和选中节点相连（is-hot）时沿方向流动，打回反向 */}
      {!prefersReducedMotion() && (
        <>
          <path d={path} pathLength={1} className={`wf-sweep e-${kind}`} style={{ '--d': `${Math.round(Math.min(1100, Math.max(0, sourceX) * 0.45))}ms` } as CSSProperties} aria-hidden />
          <path d={path} className={`wf-flow e-${kind}`} aria-hidden />
        </>
      )}
      {(label || removable) && (
        <EdgeLabelRenderer>
          <div className={`wf-edge-label e-${kind} nodrag nopan`} style={{ transform: `translate(-50%, -50%) translate(${lx}px, ${ly}px)` }}>
            {label && <span>{label}</span>}
            {removable && (
              <button className="wf-edge-del" onClick={() => void rf.deleteElements({ edges: [{ id }] })} aria-label="删除这条依赖" title="删除依赖（Delete）">
                <X />
              </button>
            )}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  )
}

export const edgeTypes = { wf: WfEdgeView }
