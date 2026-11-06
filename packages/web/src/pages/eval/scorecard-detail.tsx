import type { NodeScorecard } from '@taktflow/core'
import { FlaskConical } from 'lucide-react'
import { useAsync } from '../../api'
import { Dialog, SkeletonRows, StatusDot } from '../../components/ui'
import { useLastDefined } from '../../lib/motion'
import { fmtCost, fmtDate, fmtDuration, fmtTokens, totalTokens } from '../../lib/format'
import { Link } from '../../lib/router'
import { NODE_STATUS } from '../../lib/status'
import { pct, shortHash } from './labels'
import { Downstream, RegressionTag } from './scorecard-table'
import { Sparkline } from './sparkline'

/** 最近执行：同一 workflow 的运行里含这个节点（planner / loop 展开按前缀）的最近 6 次。 */
function RecentExecutions({ workflowId, nodeId }: { workflowId?: string; nodeId?: string }) {
  const q = useAsync(async (ds) => {
    if (!nodeId) return []
    // 不同 workflow 有同名节点（implement、review-code…），只看成绩单所属 workflow 的运行
    const runs = (await ds.runs()).filter((r) => r.kind !== 'task' && (!workflowId || r.workflowId === workflowId)).slice(0, 8)
    const details = await Promise.all(runs.map((r) => ds.run(r.runId).catch(() => undefined)))
    return details.flatMap((d, i) => {
      const n = d?.graph.nodes.find((x) => x.id === nodeId) ?? d?.graph.nodes.find((x) => x.id.startsWith(`${nodeId}/`))
      return d && n && n.status !== 'pending' ? [{ run: runs[i]!, node: n }] : []
    }).slice(0, 6)
  }, [workflowId, nodeId])
  if (!q.data) return <SkeletonRows rows={3} gap={10} />
  if (q.data.length === 0) return <p className="faint sc-empty">最近的运行里没有这个节点的执行。</p>
  return (
    <ul className="sc-recent">
      {q.data.map(({ run, node }) => (
        <li key={run.runId}>
          <StatusDot tone={NODE_STATUS[node.status].tone} />
          <Link to={`/run/${run.runId}?node=${encodeURIComponent(node.id)}&dtab=recipe`} className="mono">
            {run.runId}
          </Link>
          <span className="mono faint">{run.requirementId}</span>
          <span className="faint">{NODE_STATUS[node.status].label}</span>
          {node.attempts > 1 && <span className="faint num">尝试 {node.attempts}</span>}
          <span className="sc-recent-at faint">{fmtDate(run.startedAt)}</span>
        </li>
      ))}
    </ul>
  )
}

function Metric({ label, value, sub, tone }: { label: string; value: string | number; sub?: string; tone?: 'bad' | 'warn' }) {
  return (
    <div className="sc-metric">
      <div className="sc-metric-label">{label}</div>
      <div className={`sc-metric-value num${tone ? ` sc-${tone}` : ''}`}>{value}</div>
      {sub && <div className="sc-metric-sub">{sub}</div>}
    </div>
  )
}

export function ScorecardDetail({ card, onClose }: { card?: NodeScorecard; onClose: () => void }) {
  const c = useLastDefined(card)
  const evalTarget = c?.key.by === 'skill' ? `skill:${c.key.skill?.name}` : c?.key.nodeId && c.key.workflowId ? `node:${c.key.workflowId}/${c.key.nodeId}` : undefined
  return (
    <Dialog
      open={Boolean(card)}
      onClose={onClose}
      size="lg"
      title={
        <span className="sc-dlg-title">
          {c?.label}
          {c && <RegressionTag c={c} />}
        </span>
      }
      description={c && <span className="mono">{[c.key.workflowId, c.key.nodeId, c.key.recipeKey && shortHash(c.key.recipeKey, 16), c.role].filter(Boolean).join(' · ')}</span>}
      footer={
        evalTarget && (
          <Link to={`/eval?tab=runs&new=${encodeURIComponent(evalTarget)}`} className="btn btn-sm btn-primary" onClick={onClose}>
            <FlaskConical />
            用回放评测验证
          </Link>
        )
      }
    >
      {c && (
        <div className="sc-detail">
          {c.regression?.suspected && <div className="sc-callout">{c.regression.reason}</div>}
          <div className="sc-metrics">
            <Metric label="执行" value={c.executions} sub={c.durationMsAvg ? `平均 ${fmtDuration(c.durationMsAvg)}` : undefined} />
            <Metric label="一次通过率" value={pct(c.firstPassRate)} tone={c.regression?.suspected ? 'bad' : undefined} />
            <Metric label="评审负担" value={c.review.roundsAvg !== undefined ? `${c.review.roundsAvg.toFixed(1)} 轮` : '—'} sub={`打回 ${c.review.reworks} · B${c.review.issues.blocker} M${c.review.issues.major} m${c.review.issues.minor} n${c.review.issues.nit}`} />
            <Metric label="人工改写" value={pct(c.humanEdits.rate)} sub={`语义 ${c.humanEdits.semantic} · 措辞 ${c.humanEdits.cosmetic}`} />
            <Metric label="自检" value={`${c.completionUnmet} / ${c.suppressed}`} sub="未满足 / 指纹抑制" />
            <Metric label="逃逸缺陷" value={c.escapes} tone={c.escapes > 0 ? 'bad' : undefined} sub="已确认引入" />
            <Metric label="检出率" value={c.detection ? pct(c.detection.rate) : '—'} tone={c.detection?.rate !== undefined && c.detection.rate < 0.7 ? 'warn' : undefined} sub={c.detection ? `拦下 ${c.detection.caught} · 漏检 ${c.detection.missed}` : '只算评审 / 门禁与漏检节点'} />
            <Metric label="成本" value={fmtCost(c.usage.costUsd)} sub={`${fmtTokens(totalTokens(c.usage))} tokens`} />
          </div>
          <section>
            <h3 className="sc-h3">下游判决</h3>
            <Downstream d={c.downstream} />
          </section>
          <section>
            <h3 className="sc-h3">
              配方趋势 <Sparkline trend={c.trend} regressed={c.regression?.suspected} width={120} height={26} />
            </h3>
            <table className="table sc-trend">
              <thead>
                <tr>
                  <th>配方</th>
                  <th>首次出现</th>
                  <th className="r">执行</th>
                  <th className="r">一次通过率</th>
                </tr>
              </thead>
              <tbody>
                {(c.trend ?? []).map((t, i, a) => (
                  <tr key={t.recipeKey}>
                    <td className="mono">
                      {shortHash(t.recipeKey, 16)}
                      {i === a.length - 1 && <span className="faint"> · 当前</span>}
                    </td>
                    <td className="mono faint">{fmtDate(t.firstAt)}</td>
                    <td className="r num">{t.executions}</td>
                    <td className="r num">{pct(t.firstPassRate)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
          <section>
            <h3 className="sc-h3">最近执行</h3>
            <RecentExecutions workflowId={c.key.workflowId} nodeId={c.key.nodeId} />
          </section>
        </div>
      )}
    </Dialog>
  )
}
