import { Undo2 } from 'lucide-react'
import type { GraphNode } from '@taktflow/core'
import { useAsync } from '../../../api'
import { matchPath, useLocation } from '../../../lib/router'
import { normalizeRounds } from './review-meta'
import './dag-review.css'

/** 协议变更请求：GraphNode 带上评审轮次与打回次数。server 带上之后不再额外请求节点详情。 */
type ReviewGraphNode = GraphNode & { round?: number; maxRounds?: number; reworks?: number }

interface ReviewBadge {
  round: number
  maxRounds: number
  reworks: number
  passed: boolean
}

/**
 * review 节点的轮次信息。GraphNode 目前不带 round / maxRounds，先用节点详情补齐（只对 review 节点请求，节点状态变化时刷新）。
 */
function useReviewBadge(n: ReviewGraphNode): ReviewBadge | undefined {
  const { path } = useLocation()
  const runId = matchPath('/run/:id', path)?.id
  const inline = n.round !== undefined && n.maxRounds !== undefined
  const need = n.kind === 'review' && !inline && !!runId
  const q = useAsync((ds) => (need ? ds.node(runId!, n.id) : Promise.resolve(undefined)), [need, runId, n.id, n.status])
  if (n.kind !== 'review') return undefined
  if (inline) return { round: n.round!, maxRounds: n.maxRounds!, reworks: n.reworks ?? 0, passed: n.status === 'succeeded' }
  const r = q.data?.review
  if (!r || !r.rounds.length) return undefined
  const max = r.config.maxRounds
  const last = normalizeRounds(r.rounds, max).at(-1)!
  return { round: ((last.round - 1) % max) + 1, maxRounds: max, reworks: Math.floor((last.round - 1) / max), passed: last.passed }
}

/** DAG 节点右上角的评审角标：第 n/max 轮；打回过的再加一枚"打回 ×k"。 */
export function ReviewBadges({ node }: { node: GraphNode }) {
  const b = useReviewBadge(node)
  if (!b) return null
  const live = node.status === 'running'
  return (
    <>
      <span className={`dag-badge rv-dag-round${live ? ' live' : ''}${b.passed ? ' pass' : ''}`} title={`评审第 ${b.round} / ${b.maxRounds} 轮`}>
        <span className="rv-dag-ticks" aria-hidden>
          {Array.from({ length: b.maxRounds }, (_, i) => (
            <i key={i} className={i < b.round ? 'on' : undefined} />
          ))}
        </span>
        <span className="num">
          {b.round}/{b.maxRounds}
        </span>
      </span>
      {b.reworks > 0 && (
        <span className="dag-badge rv-dag-rework" title={`轮次用完后打回上游 ${b.reworks} 次`}>
          <Undo2 strokeWidth={2.4} />
          <span className="num">×{b.reworks}</span>
        </span>
      )}
    </>
  )
}

/** 被打回过的上游节点（GraphNode.reworks，待协议补齐）：显示"重做 ×k"。 */
export function ReworkTargetBadge({ node }: { node: GraphNode }) {
  const k = (node as ReviewGraphNode).reworks
  if (node.kind === 'review' || !k) return null
  return (
    <span className="dag-badge rv-dag-rework" title={`被评审打回重做 ${k} 次`}>
      <Undo2 strokeWidth={2.4} />
      重做 <span className="num">×{k}</span>
    </span>
  )
}

