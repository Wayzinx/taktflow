import { Undo2 } from 'lucide-react'
import type { GraphNode } from '@taktflow/core'
import { useAsync } from '../../../api'
import { matchPath, useLocation } from '../../../lib/router'
import { roundViews } from './review-rounds'
import './dag-review.css'

interface ReviewBadge {
  revision: number
  round: number
  reworks: number
  passed: boolean
}

/**
 * review 节点的修订与轮次。GraphNode 带 revision / round / reworks 时直接用；
 * 旧 server 不带时退回节点详情（只对 review 节点请求，节点状态变化时刷新）。
 */
function useReviewBadge(n: GraphNode): ReviewBadge | undefined {
  const { path } = useLocation()
  const runId = matchPath('/run/:id', path)?.id
  const inline = n.round !== undefined
  const need = n.kind === 'review' && !inline && !!runId
  const q = useAsync((ds) => (need ? ds.node(runId!, n.id) : Promise.resolve(undefined)), [need, runId, n.id, n.status])
  if (n.kind !== 'review') return undefined
  if (inline) return { revision: n.revision ?? 1, round: n.round!, reworks: n.reworks ?? Math.max(0, (n.revision ?? 1) - 1), passed: n.status === 'succeeded' }
  const r = q.data?.review
  if (!r || !r.rounds.length) return undefined
  const last = roundViews(r.rounds, r.config.maxRounds).at(-1)!
  return { revision: last.revision, round: last.round, reworks: last.revision - 1, passed: last.r.passed }
}

/** DAG 节点右上角的评审角标：`修订·轮次`（如 r2·1）；打回过的再加一枚"打回 ×k"。 */
export function ReviewBadges({ node }: { node: GraphNode }) {
  const b = useReviewBadge(node)
  if (!b) return null
  const live = node.status === 'running'
  return (
    <>
      <span className={`dag-badge rv-dag-round${live ? ' live' : ''}${b.passed ? ' pass' : ''}`} title={`评审 · 修订 ${b.revision} · 第 ${b.round} 轮${live ? '（进行中）' : ''}`}>
        {live && <i className="rv-dag-dot" aria-hidden />}
        <span className="mono num">
          r{b.revision}<span className="rv-dag-sep">·</span>{b.round}
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

/** 被打回过的上游节点：显示"重做 ×k"。 */
export function ReworkTargetBadge({ node }: { node: GraphNode }) {
  const k = node.reworks
  if (node.kind === 'review' || !k) return null
  return (
    <span className="dag-badge rv-dag-rework" title={`被评审打回重做 ${k} 次`}>
      <Undo2 strokeWidth={2.4} />
      重做 <span className="num">×{k}</span>
    </span>
  )
}
