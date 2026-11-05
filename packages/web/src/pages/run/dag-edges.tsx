import { BaseEdge, getSmoothStepPath, type Edge, type EdgeProps } from '@xyflow/react'

export type FlowEdgeData = { offset: number; borderRadius: number; color: string }
export type FlowEdge = Edge<FlowEdgeData, 'flow'>

/** 一拍（与 tokens.css 的 --takt 一致）。光点走完一条边用两拍：一拍出发、一拍到站。 */
const TAKT_MS = 1200

/**
 * 数据正在流过的边：上游已产出、下游在跑。
 * 光点按节拍从上游"送"到下游（缓入缓出，到站停半拍再发下一颗），像传送带上的工件，而不是匀速的蚂蚁线。
 * 减少动效时 CSS 隐藏光点，边本身保持运行色，信息不丢。
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
      <g className="flow-dot" aria-hidden>
        <circle r={6} className="flow-dot-halo" style={{ fill: color }}>
          <animateMotion {...motion} />
        </circle>
        <circle r={2.6} className="flow-dot-core" style={{ fill: color }}>
          <animateMotion {...motion} />
        </circle>
      </g>
    </>
  )
}

export const edgeTypes = { flow: FlowEdgeView }
