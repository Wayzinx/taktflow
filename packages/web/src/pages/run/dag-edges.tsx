import type { CSSProperties } from 'react'
import { BaseEdge, EdgeLabelRenderer, getSmoothStepPath, type Edge, type EdgeProps } from '@xyflow/react'
import { Undo2 } from 'lucide-react'
import { prefersReducedMotion } from '../../lib/motion'
import { NH, NW, REWORK_LABEL } from './dag-layout'
import './review/dag-review.css'

export type FlowEdgeData = {
  offset: number
  borderRadius: number
  color: string
  /** 数据正在流过（上游已产出、下游在跑）：走节拍光点。 */
  live?: boolean
  /** 入场信号的延迟（ms），按源节点横向位置排先后。 */
  delay?: number
  /** 悬停 / 选中节点的上下游：沿边流动。 */
  hl?: boolean
  /** 源节点刚完成（或回放里目标节点刚开始）：一颗信号沿边送过去；值变了就重播。 */
  pulse?: number
}
export type FlowEdge = Edge<FlowEdgeData, 'flow'>

/** 一拍（与 tokens.css 的 --takt 一致）。光点走完一条边用两拍：一拍出发、一拍到站。 */
const TAKT_MS = 1200

/**
 * 依赖与判决路由边（docs/design/27 §2.1）。边本身照常画，动效都是叠在上面的覆盖层，pathLength=1 让 CSS 按比例走：
 * - 入场：一道短信号从源扫到目标（只在挂载时播一次，按 delay 从左到右排开）；
 * - 悬停 / 选中：沿边流动的虚线；
 * - 完成交接：一颗彗星沿边送到下游（pulse 变了重播）；
 * - 运行中：节拍光点，上游 → 下游，到站停半拍。
 * 减少动效时不播入场、流动和彗星；运行中的光点静止停在边的中点，边保持运行色，信息不丢。
 */
export function FlowEdgeView(props: EdgeProps<FlowEdge>) {
  const { sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data, markerEnd, style, label, labelStyle, labelBgStyle, labelBgPadding, labelBgBorderRadius } = props
  const [path, labelX, labelY] = getSmoothStepPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, offset: data?.offset, borderRadius: data?.borderRadius })
  const color = data?.color ?? 'var(--st-running)'
  const reduced = prefersReducedMotion()
  const dur = `${(TAKT_MS * 2) / 1000}s`
  const motion = { dur, repeatCount: 'indefinite', path, calcMode: 'spline', keyTimes: '0;0.8;1', keyPoints: '0;1;1', keySplines: '0.65 0 0.35 1;0 0 1 1' }
  // 普通依赖边是灰的，信号用强调色才看得见；判决路由等有色的边沿用自己的颜色
  const signal = color === 'var(--edge)' ? 'var(--accent)' : color
  const tint = { stroke: signal, '--d': `${data?.delay ?? 0}ms` } as CSSProperties
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
      {!reduced && <path d={path} pathLength={1} className="edge-sweep" style={tint} aria-hidden />}
      {data?.hl && !reduced && <path d={path} className="edge-hl" style={{ stroke: signal }} aria-hidden />}
      {data?.pulse && !reduced ? <path key={data.pulse} d={path} pathLength={1} className="edge-comet" style={{ stroke: signal }} aria-hidden /> : null}
      {data?.live && (
        <>
          <path d={path} className="flow-trail" style={{ stroke: color }} />
          {reduced ? (
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
      )}
    </>
  )
}

export type ReworkEdgeData = { live?: boolean; count?: number; delay?: number; hl?: boolean }
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
      <BaseEdge id={id} path={path} markerEnd={`url(#${arrow})`} className={`rv-edge-path${data?.live || data?.hl ? ' live' : ''}`} style={{ opacity: style?.opacity }} />
      {/* 打回的入场信号也从源走向目标：和数据流方向相反，看得出是"退回去" */}
      {!prefersReducedMotion() && <path d={path} pathLength={1} className="edge-sweep is-rework" style={{ '--d': `${(data?.delay ?? 0) + 240}ms` } as CSSProperties} aria-hidden />}
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
