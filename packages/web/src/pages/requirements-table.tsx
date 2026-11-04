import type { RequirementSummary } from '@taktflow/core'
import { Avatar, StatusBadge } from '../components/ui'
import { StageBar } from '../components/stage-bar'
import { fmtCost, fmtRelative, fmtTokens, totalTokens } from '../lib/format'
import { navigate } from '../lib/router'
import { REQ_STATUS } from '../lib/status'

/** 需求表：总览（紧凑）和需求列表页（完整）共用。 */
export function RequirementsTable({ rows, full }: { rows: RequirementSummary[]; full?: boolean }) {
  return (
    <table className="table req-table">
      <thead>
        <tr>
          <th style={{ width: 84 }}>ID</th>
          <th>需求</th>
          {full && <th style={{ width: 120 }}>负责人</th>}
          <th style={{ width: full ? 300 : 270 }}>阶段</th>
          <th className="r" style={{ width: 56 }}>
            待办
          </th>
          <th className="r" style={{ width: 76 }}>
            Token
          </th>
          {full && (
            <th className="r" style={{ width: 76 }}>
              成本
            </th>
          )}
          {full && (
            <th className="r" style={{ width: 96 }}>
              更新
            </th>
          )}
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.id} className="clickable" onClick={() => navigate(`/req/${r.id}`)}>
            <td>
              <span className="mono req-id">{r.id}</span>
            </td>
            <td>
              <div className="req-title-cell">
                <span className="req-title truncate">{r.title}</span>
                <StatusBadge meta={REQ_STATUS[r.status]} />
              </div>
              {!full && (
                <div className="req-meta">
                  {r.owner && (
                    <>
                      <Avatar name={r.owner} size={14} />
                      <span>{r.owner}</span>
                      <span className="dot-sep" />
                    </>
                  )}
                  <span title={r.updatedAt}>更新于 {fmtRelative(r.updatedAt)}</span>
                </div>
              )}
            </td>
            {full && (
              <td>
                {r.owner && (
                  <span className="owner-cell">
                    <Avatar name={r.owner} size={20} />
                    {r.owner}
                  </span>
                )}
              </td>
            )}
            <td>
              <StageBar stages={r.stages} />
            </td>
            <td className="r">{r.pendingAttention > 0 ? <span className="pending-pill num">{r.pendingAttention}</span> : <span className="faint">—</span>}</td>
            <td className="r mono num">{totalTokens(r.usage) ? fmtTokens(totalTokens(r.usage)) : <span className="faint">—</span>}</td>
            {full && <td className="r mono num">{r.usage.costUsd ? fmtCost(r.usage.costUsd) : <span className="faint">—</span>}</td>}
            {full && (
              <td className="r faint" title={r.updatedAt}>
                {fmtRelative(r.updatedAt)}
              </td>
            )}
          </tr>
        ))}
      </tbody>
    </table>
  )
}
