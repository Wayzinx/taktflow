import { GitBranch } from 'lucide-react'
import type { RunSummary } from '@taktflow/core'
import { TierGlyph } from '../../components/tier-glyph'
import { EmptyState, SkeletonRows, StatusBadge } from '../../components/ui'
import { durationBetween, fmtCost, fmtDate, fmtDuration, fmtRelative, fmtTokens, totalTokens } from '../../lib/format'
import { navigate } from '../../lib/router'
import { RUN_STATUS } from '../../lib/status'

export function RunsTab({ runs }: { runs?: RunSummary[] }) {
  if (!runs) return <div className="card"><SkeletonRows rows={3} /></div>
  if (runs.length === 0)
    return (
      <div className="card">
        <EmptyState icon={GitBranch} title="还没有运行" hint={<>在项目目录执行 <span className="mono">takt run sdlc --req &lt;REQ&gt;</span> 开始第一次运行。</>} />
      </div>
    )
  return (
    <div className="card">
      <table className="table">
        <thead>
          <tr>
            <th>运行</th>
            <th>状态</th>
            <th style={{ width: '28%' }}>进度</th>
            <th>开始</th>
            <th className="r">耗时</th>
            <th className="r">Token</th>
            <th className="r">成本</th>
          </tr>
        </thead>
        <tbody>
          {runs.map((r) => {
            const pct = r.progress.total ? r.progress.done / r.progress.total : 0
            const failPct = r.progress.total ? r.progress.failed / r.progress.total : 0
            return (
              <tr key={r.runId} className="clickable" onClick={() => navigate(`/run/${r.runId}`)}>
                <td>
                  <div className="mono" style={{ fontWeight: 560 }}>{r.runId}</div>
                  <div className="run-sub faint">
                    {r.tier && <TierGlyph tier={r.tier} size={12} />}
                    <span className="mono">{r.workflowId}</span>
                    {r.kind === 'task' && <span title={r.origin?.title}>· 临时任务{r.origin?.title ? `：${r.origin.title}` : ''}</span>}
                  </div>
                </td>
                <td>
                  <StatusBadge meta={RUN_STATUS[r.status]} />
                </td>
                <td>
                  <div className="run-progress">
                    <span className="run-progress-bar">
                      <span style={{ width: `${pct * 100}%` }} />
                      <span className="fail" style={{ width: `${failPct * 100}%` }} />
                    </span>
                    <span className="mono num faint">
                      {r.progress.done}/{r.progress.total}
                    </span>
                  </div>
                </td>
                <td title={fmtDate(r.startedAt)}>{fmtRelative(r.startedAt)}</td>
                <td className="r mono">{fmtDuration(durationBetween(r.startedAt, r.endedAt) ?? 0)}</td>
                <td className="r mono">{fmtTokens(totalTokens(r.usage))}</td>
                <td className="r mono">{fmtCost(r.usage.costUsd)}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
