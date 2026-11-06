import type { CSSProperties } from 'react'
import { ClipboardCheck, Undo2 } from 'lucide-react'
import type { ReviewSummary } from '@taktflow/core'
import { useAsync } from '../../api'
import { EmptyState, ErrorState, SkeletonRows, StatusBadge } from '../../components/ui'
import { Link, navigate } from '../../lib/router'
import { FacetTags } from '../run/review/facet-tags'
import { REVIEW_STATUS, VERDICT_META, targetText, toneColor } from '../run/review/review-meta'
import './reviews-tab.css'

/** 未关闭问题：优先用 facets（按人工处置过滤、groupKey 去重），旧数据退回最近一轮各评审者的计数。 */
const openOf = (r: ReviewSummary) => (r.facets ? r.facets.open.blocker + r.facets.open.major + r.facets.open.minor + r.facets.open.nit : r.latest.reduce((m, x) => m + x.openIssues, 0))

const nodeHref = (r: ReviewSummary) => `/run/${r.runId}?node=${encodeURIComponent(r.nodeId)}&dtab=review`

/** 需求页 · 评审：所有评审节点的汇总，点开跳到运行页对应节点的评审 Tab。 */
export function ReviewsTab({ id }: { id: string }) {
  const q = useAsync((ds) => ds.requirementReviews(id), [id])
  if (q.error) return <div className="card"><ErrorState error={q.error} onRetry={q.reload} /></div>
  if (!q.data) return <div className="card"><SkeletonRows rows={4} /></div>
  const list = q.data
  if (!list.length)
    return (
      <div className="card">
        <EmptyState icon={ClipboardCheck} title="还没有评审" hint="workflow 里的 review 节点开始评审后，每个节点的轮次、结论和未解决问题会汇总在这里。" />
      </div>
    )
  const open = list.reduce((n, r) => n + openOf(r), 0)
  const reworks = list.reduce((n, r) => n + r.reworks, 0)
  const passed = list.filter((r) => r.status === 'passed').length
  const stale = list.filter((r) => r.facets?.freshness === 'stale').length
  const active = list.filter((r) => r.status === 'in_review' || r.status === 'revising').length
  return (
    <div className="rvs">
      <div className="rvs-stats" role="list">
        <Stat label="评审节点" value={list.length} />
        <Stat label="已结束" value={passed} tone="success" />
        <Stat label="进行中" value={active} tone={active ? 'running' : undefined} />
        <Stat label="未解决问题" value={open} tone={open ? 'waiting' : undefined} />
        <Stat label="打回重做" value={reworks} tone={reworks ? 'stale' : undefined} />
        <Stat label="结论已过期" value={stale} tone={stale ? 'stale' : undefined} />
      </div>
      <div className="card">
        <table className="table rvs-table">
          <thead>
            <tr>
              <th>评审节点</th>
              <th>状态</th>
              <th>结论 · 覆盖 · 新鲜度</th>
              <th>修订 · 轮次</th>
              <th>最近一轮评审者</th>
              <th className="r">未解决</th>
            </tr>
          </thead>
          <tbody>
            {list.map((r) => {
              const unresolved = openOf(r)
              return (
                <tr key={`${r.runId}/${r.nodeId}`} className="clickable" onClick={() => navigate(nodeHref(r))}>
                  <td>
                    <Link to={nodeHref(r)} className="rvs-title" onClick={(e) => e.stopPropagation()}>
                      {r.title}
                    </Link>
                    <div className="rvs-sub mono faint truncate" title={`${r.runId} · ${r.nodeId}\n${targetText(r.target)}`}>
                      {r.nodeId} · {targetText(r.target)}
                    </div>
                  </td>
                  <td>
                    <StatusBadge meta={REVIEW_STATUS[r.status]} />
                  </td>
                  <td>
                    {r.facets ? <FacetTags facets={r.facets} compact /> : <span className="faint">—</span>}
                  </td>
                  <td>
                    <RoundMeter revision={r.revision ?? r.reworks + 1} round={r.round} max={r.maxRounds} />
                    {r.reworks > 0 && (
                      <span className="rvs-rework" title="轮次用完后打回上游重做的次数">
                        <Undo2 />
                        打回 <span className="num">{r.reworks}</span>
                      </span>
                    )}
                  </td>
                  <td>
                    <div className="rvs-verdicts">
                      {r.latest.map((x) => {
                        const v = VERDICT_META[x.verdict]
                        return (
                          <span key={x.reviewer} className="rvs-verdict" style={{ '--tone': toneColor(v.tone) } as CSSProperties} title={`${x.reviewer}：${v.label}${x.score !== undefined ? ` · ${x.score} 分` : ''}${x.openIssues ? ` · ${x.openIssues} 个未解决` : ''}`}>
                            <v.icon strokeWidth={2.6} />
                            <span className="mono">{x.reviewer}</span>
                            {x.score !== undefined && <span className="num rvs-score">{x.score}</span>}
                          </span>
                        )
                      })}
                    </div>
                  </td>
                  <td className={`r mono num${unresolved ? ' rvs-open' : ' faint'}`}>{unresolved}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function Stat({ label, value, tone }: { label: string; value: number; tone?: 'success' | 'running' | 'waiting' | 'stale' }) {
  return (
    <div className="rvs-stat" role="listitem" style={tone ? ({ '--tone': toneColor(tone) } as CSSProperties) : undefined}>
      <span className="rvs-stat-label">{label}</span>
      <span className={`rvs-stat-value num${tone ? ' toned' : ''}`}>{value}</span>
    </div>
  )
}

/** 修订 · 轮次：rN 加 maxRounds 格刻度（当前修订内已用的格点亮，像节拍尺）。 */
function RoundMeter({ revision, round, max }: { revision: number; round: number; max: number }) {
  return (
    <span className="rvs-rounds" title={`修订 ${revision} · 第 ${round} / ${max} 轮`}>
      <span className="mono rvs-rev">r{revision}</span>
      <span className="rvs-ticks" aria-hidden>
        {Array.from({ length: max }, (_, i) => (
          <span key={i} className={i < round ? 'on' : undefined} />
        ))}
      </span>
      <span className="num">
        {round}/{max}
      </span>
    </span>
  )
}
