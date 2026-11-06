import { BaseEdge, EdgeLabelRenderer, getSmoothStepPath, type Edge, type EdgeProps } from '@xyflow/react'
import { Undo2 } from 'lucide-react'
import { prefersReducedMotion } from '../../lib/motion'
import { NH, NW, REWORK_LABEL } from './dag-layout'
import './review/dag-review.css'

export type FlowEdgeData = { offset: number; borderRadius: number; color: string }
export type FlowEdge = Edge<FlowEdgeData, 'flow'>

/** 一拍（与 tokens.css 的 --takt 一致）。光点走完一条边用两拍：一拍出发、一拍到站。 */
const TAKT_MS = 1200

/**
 * 数据正在流过的边：上游已产出、下游在跑。
 * 光点按节拍从上游"送"到下游（缓入缓出，到站停半拍再发下一颗），像传送带上的工件，而不是匀速的蚂蚁线。
 * 减少动效时不跑 SMIL 动画：光点静止停在边的中点（仍可见），边本身保持运行色，信息不丢。
 */
export function FlowEdgeView(props: EdgeProps<FlowEdge>) {
  const { sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data, markerEnd, style, label, labelStyle, labelBgStyle, labelBgPadding, labelBgBorderRadius } = props
  const [path, labelX, labelY] = getSmoothStepPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, offset: data?.offset, borderRadius: data?.borderRadius })
  const color = data?.color ?? 'var(--st-running)'
  const dur = `${(TAKT_MS * 2) / 1000}s`
  const motion = { dur, repeatCount: 'indefinite', path, calcMode: 'spline', keyTimes: '0;0.8;1', keyPoints: '0;1;1', keySplines: '0.65 0 0.35 1;0 0 1 1' }
  return (
    <>
      <BaseEdge
        path={path}
        markerEnd={markerEnd}
        style={style}
        label={label}
        labelX={labelX}
        labelY={labelY}
        labelStyle={labelStyle}
        labelBgStyle={labelBgStyle}
        labelBgPadding={labelBgPadding}
        labelBgBorderRadius={labelBgBorderRadius}
      />
      <path d={path} className="flow-trail" style={{ stroke: color }} />
      {prefersReducedMotion() ? (
        <g className="flow-dot-still" aria-hidden>
          <circle cx={labelX} cy={labelY} r={6} style={{ fill: color, opacity: 0.18 }} />
          <circle cx={labelX} cy={labelY} r={2.6} style={{ fill: color }} />
        </g>
      ) : (
        <g className="flow-dot" aria-hidden>
          <circle r={6} className="flow-dot-halo" style={{ fill: color }}>
            <animateMotion {...motion} />
          </circle>
          <circle r={2.6} className="flow-dot-core" style={{ fill: color }}>
            <animateMotion {...motion} />
          </circle>
        </g>
      )}
    </>
  )
}

export type ReworkEdgeData = { live?: boolean; count?: number }
export type ReworkEdge = Edge<ReworkEdgeData, 'rework'>


/**
 * 打回边：评审轮次用完后回到上游重做。和数据流方向相反，画成节点上方的一道虚线弧，
 * 不和依赖边的折线抢位置；标签带回退图标，颜色用"过期 / 需要重跑"的 stale 色。
 */
export function ReworkEdgeView({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data, style }: EdgeProps<ReworkEdge>) {
  const arrow = `rv-arrow-${id.replace(/[^\w-]/g, '_')}`
  // layout 给的是 右 → 左 句柄；打回边方向相反，自己选路线
  const above = targetY < sourceY - NH / 2 && Math.abs(targetX + NW - sourceX) < NW
  let path: string
  let lx: number
  let ly: number
  if (above) {
    // 同一列、目标在上方：从源节点右侧绕回目标节点右侧
    const tx = targetX + NW
    const k = Math.min(110, 48 + (sourceY - targetY) * 0.12)
    path = `M ${sourceX},${sourceY} C ${sourceX + k},${sourceY} ${tx + k},${targetY} ${tx},${targetY}`
    lx = (sourceX + tx) / 2 + k * 0.75
    ly = (sourceY + targetY) / 2
  } else if (targetX < sourceX) {
    // 目标在左边：节点上方的一道弧
    const h = Math.min(130, 74 + Math.abs(sourceX - targetX) * 0.06)
    path = `M ${sourceX},${sourceY} C ${sourceX + 56},${sourceY - h} ${targetX - 56},${targetY - h} ${targetX},${targetY}`
    lx = (sourceX + targetX) / 2
    ly = (sourceY + targetY) / 2 - h * 0.75
  } else {
    ;[path, lx, ly] = getSmoothStepPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, borderRadius: 12 })
  }
  return (
    <>
      {/* layout 给的箭头是路由边的颜色，打回边用自己的 stale 色箭头 */}
      <defs>
        <marker id={arrow} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="9" markerHeight="9" orient="auto-start-reverse">
          <path d="M0,1 L10,5 L0,9 z" className="rv-edge-arrow" />
        </marker>
      </defs>
      <path d={path} className="rv-edge-trail" style={{ opacity: style?.opacity }} />
      <BaseEdge id={id} path={path} markerEnd={`url(#${arrow})`} className={`rv-edge-path${data?.live ? ' live' : ''}`} style={{ opacity: style?.opacity }} />
      <EdgeLabelRenderer>
        <span className="rv-edge-label nodrag nopan" style={{ transform: `translate(-50%, -50%) translate(${lx}px, ${ly}px)` }}>
          <Undo2 strokeWidth={2.4} />
          {REWORK_LABEL}
          {data?.count ? <span className="num">×{data.count}</span> : null}
        </span>
      </EdgeLabelRenderer>
    </>
  )
}

export const edgeTypes = { flow: FlowEdgeView, rework: ReworkEdgeView }
