import type { RequirementSummary } from "@taktflow/core";
import {
  Avatar,
  StatusBadge,
  useFlashRows,
  useStagger,
  vtName,
} from "../components/ui";
import { TierGlyph, TIER_LABEL } from "../components/tier-glyph";
import { RunBars } from "../components/viz";
import { fmtCost, fmtRelative, fmtTokens, totalTokens } from "../lib/format";
import { navigate } from "../lib/router";
import { REQ_STATUS } from "../lib/status";
import { CurrentNodeCell } from "./requirements-current";
import { StageCell } from "./overview-lanes";
import { RiskMark, type RiskIndex } from "./requirements-risk";

/**
 * 需求表：总览（紧凑）和需求列表页（完整）共用。
 * 首屏逐行入场（useStagger），之后新出现的需求闪一下（useFlashRows）；标题带共享元素过渡名，点进详情时标题平移到页头。
 */
export function RequirementsTable({
  rows,
  full,
  risks,
}: {
  rows: RequirementSummary[];
  full?: boolean;
  risks?: RiskIndex;
}) {
  const st = useStagger(rows.length);
  const flash = useFlashRows(rows.map((r) => r.id));
  // 容器查询按可用宽度收起次要列（停靠面板打开时主区只有 ~750px，固定列宽会把标题列挤没）
  return (
    <div className="req-table-wrap">
      <table className="table req-table">
        <thead>
          <tr>
            <th style={{ width: 84 }}>ID</th>
            <th>需求</th>
            {full && (
              <th className="c-owner" style={{ width: 120 }}>
                负责人
              </th>
            )}
            <th style={{ width: full ? 168 : 220 }}>阶段</th>
            {full && (
              <th className="c-node" style={{ width: 148 }}>
                当前节点
              </th>
            )}
            <th className="r" style={{ width: 56 }}>
              待办
            </th>
            <th className="r" style={{ width: full ? 124 : 76 }}>
              Token
            </th>
            {full && (
              <th className="r c-cost" style={{ width: 76 }}>
                成本
              </th>
            )}
            {full && (
              <th className="r c-updated" style={{ width: 84 }}>
                更新
              </th>
            )}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr
              key={r.id}
              data-steward-anchor={r.id}
              className={`clickable ${st(i).className ?? ""} ${flash(r.id)}`}
              style={st(i).style}
              tabIndex={0}
              onClick={() => navigate(`/req/${r.id}`)}
              onKeyDown={(e) => e.key === "Enter" && navigate(`/req/${r.id}`)}
            >
              <td>
                <span className="req-id-cell">
                  <span className="mono req-id">{r.id}</span>
                  {r.tier && (
                    <span
                      className="req-tier"
                      title={`${TIER_LABEL[r.tier].title}：${TIER_LABEL[r.tier].hint}`}
                    >
                      <TierGlyph tier={r.tier} size={12} label={false} />
                      {r.tier}
                    </span>
                  )}
                </span>
              </td>
              <td>
                <div className="req-title-cell">
                  <span
                    className="req-title truncate"
                    style={{ viewTransitionName: vtName("req", r.id) }}
                  >
                    {r.title}
                  </span>
                  <StatusBadge meta={REQ_STATUS[r.status]} />
                  <RiskMark risks={risks?.get(r.id)} reqId={r.id} />
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
                    <span title={r.updatedAt}>
                      更新于 {fmtRelative(r.updatedAt)}
                    </span>
                    {r.current && (
                      <>
                        <span className="dot-sep" />
                        <CurrentNodeCell
                          current={r.current}
                          tier={r.tier}
                          compact
                        />
                      </>
                    )}
                  </div>
                )}
              </td>
              {full && (
                <td className="c-owner">
                  {r.owner && (
                    <span className="owner-cell">
                      <Avatar name={r.owner} size={20} />
                      <span className="truncate">{r.owner}</span>
                    </span>
                  )}
                </td>
              )}
              <td>
                <StageCell r={r} />
              </td>
              {full && (
                <td className="c-node">
                  <CurrentNodeCell current={r.current} tier={r.tier} />
                </td>
              )}
              <td className="r">
                {r.pendingAttention > 0 ? (
                  <span className="pending-pill num">{r.pendingAttention}</span>
                ) : (
                  <span className="faint">—</span>
                )}
              </td>
              <td className="r mono num">
                {totalTokens(r.usage) ? (
                  <span className="tok-cell">
                    {full && (r.recentRuns?.length ?? 0) > 1 && <RunBars runs={r.recentRuns!} height={14} />}
                    {fmtTokens(totalTokens(r.usage))}
                  </span>
                ) : (
                  <span className="faint">—</span>
                )}
              </td>
              {full && (
                <td className="r mono num c-cost">
                  {r.usage.costUsd ? (
                    fmtCost(r.usage.costUsd)
                  ) : (
                    <span className="faint">—</span>
                  )}
                </td>
              )}
              {full && (
                <td className="r faint c-updated" title={r.updatedAt}>
                  {fmtRelative(r.updatedAt)}
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
