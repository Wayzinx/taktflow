import type { RequirementSummary } from '@taktflow/core'
import { Avatar, StatusBadge } from '../components/ui'
import { StageBar } from '../components/stage-bar'
import { TierGlyph, TIER_LABEL } from '../components/tier-glyph'
import { fmtCost, fmtRelative, fmtTokens, totalTokens } from '../lib/format'
import { navigate } from '../lib/router'
import { REQ_STATUS } from '../lib/status'
import { CurrentNodeCell } from './requirements-current'

/**
 * 需求表：总览（紧凑）和需求列表页（完整）共用。
 * 列宽在 overview.css 里按表格容器宽度（@container reqtable）调整：窄时先隐藏低优先级列，标题列始终留足宽度。
 */
export function RequirementsTable({ rows, full }: { rows: RequirementSummary[]; full?: boolean }) {
  return (
    <div className="req-table-wrap">
    <table className={`table req-table${full ? ' full' : ' compact'}`}>
      <thead>
        <tr>
          {full && <th className="col-id">ID</th>}
          <th className="col-title">需求</th>
          {full && <th className="col-owner">负责人</th>}
          <th className="col-stage">阶段</th>
          {full && <th className="col-current">当前节点</th>}
          <th className="r col-pending">待办</th>
          <th className="r col-tokens">Token</th>
          {full && <th className="r col-cost">成本</th>}
          {full && <th className="r col-updated">更新</th>}
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.id} className="clickable" onClick={() => navigate(`/req/${r.id}`)}>
            {full && (
              <td className="col-id">
                <ReqId r={r} />
              </td>
            )}
            <td className="col-title">
              <div className="req-title-cell">
                <span className="req-title truncate">{r.title}</span>
                <StatusBadge meta={REQ_STATUS[r.status]} />
              </div>
              {!full && (
                <div className="req-meta">
                  <ReqId r={r} />
                  <span className="dot-sep" />
                  {r.owner && (
                    <>
                      <Avatar name={r.owner} size={14} />
                      <span>{r.owner}</span>
                      <span className="dot-sep" />
                    </>
                  )}
                  <span title={r.updatedAt}>更新于 {fmtRelative(r.updatedAt)}</span>
                  {r.current && (
                    <>
                      <span className="dot-sep" />
                      <CurrentNodeCell current={r.current} tier={r.tier} compact />
                    </>
                  )}
                </div>
              )}
            </td>
            {full && (
              <td className="col-owner">
                {r.owner && (
                  <span className="owner-cell">
                    <Avatar name={r.owner} size={20} />
                    {r.owner}
                  </span>
                )}
              </td>
            )}
            <td className="col-stage">
              <StageBar stages={r.stages} empty={r.latestRunId ? '未分阶段' : '尚未运行'} />
            </td>
            {full && (
              <td className="col-current">
                <CurrentNodeCell current={r.current} tier={r.tier} />
              </td>
            )}
            <td className="r col-pending">{r.pendingAttention > 0 ? <span className="pending-pill num">{r.pendingAttention}</span> : <span className="faint">—</span>}</td>
            <td className="r mono num col-tokens">{totalTokens(r.usage) ? fmtTokens(totalTokens(r.usage)) : <span className="faint">—</span>}</td>
            {full && <td className="r mono num col-cost">{r.usage.costUsd ? fmtCost(r.usage.costUsd) : <span className="faint">—</span>}</td>}
            {full && (
              <td className="r faint col-updated" title={r.updatedAt}>
                {fmtRelative(r.updatedAt)}
              </td>
            )}
          </tr>
        ))}
      </tbody>
    </table>
    </div>
  )
}

/** 需求 ID（长，等宽字体不折行）+ 档位。 */
function ReqId({ r }: { r: RequirementSummary }) {
  return (
    <span className="req-id-cell">
      <span className="mono req-id" title={r.id}>{r.id}</span>
      {r.tier && (
        <span className="req-tier" title={`${TIER_LABEL[r.tier].title}：${TIER_LABEL[r.tier].hint}`}>
          <TierGlyph tier={r.tier} size={12} label={false} />
          {r.tier}
        </span>
      )}
    </span>
  )
}
