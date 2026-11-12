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
import { costOf, fmtDateTime, fmtRelative, fmtTokens, totalTokens } from "../lib/format";
import { navigate } from "../lib/router";
import { useMemberName } from "../api";
import { REQ_STATUS } from "../lib/status";
import { CurrentNodeCell } from "./requirements-current";
import { StageCell } from "./overview-lanes";
import { RiskMark, type RiskIndex } from "./requirements-risk";
import type { ReqSort, ReqView } from "./requirements-query";

/** 可排序的表头：按钮 + aria-sort；没给 onSort 时就是普通表头。 */
function SortTh({
  k,
  label,
  sort,
  onSort,
  className,
  width,
  title,
}: {
  k: ReqSort;
  label: string;
  sort?: Pick<ReqView, "sort" | "order">;
  onSort?: (key: ReqSort) => void;
  className?: string;
  width: number;
  title?: string;
}) {
  const on = sort?.sort === k;
  return (
    <th
      className={className}
      style={{ width }}
      aria-sort={on ? (sort.order === "asc" ? "ascending" : "descending") : undefined}
      title={title}
    >
      {onSort ? (
        <button type="button" className="th-sort" data-on={on || undefined} onClick={() => onSort(k)}>
          {label}
          <span className="th-sort-mark" aria-hidden>
            {on ? (sort.order === "asc" ? "↑" : "↓") : "↕"}
          </span>
        </button>
      ) : (
        label
      )}
    </th>
  );
}

const QUALITY_TITLE =
  "拦截：交付前被拦下的问题个数（未通过的门禁检查项、未通过评审轮里的 blocker / major 意见、判为代码缺陷的失败、未满足的完成标准、被抑制的重复重试）";

/**
 * 需求表：总览（紧凑）和需求列表页（完整）共用。
 * 首屏逐行入场（useStagger），之后新出现的需求闪一下（useFlashRows）；标题带共享元素过渡名，点进详情时标题平移到页头。
 */
export function RequirementsTable({
  rows,
  full,
  risks,
  sort,
  onSort,
}: {
  rows: RequirementSummary[];
  full?: boolean;
  risks?: RiskIndex;
  sort?: Pick<ReqView, "sort" | "order">;
  onSort?: (key: ReqSort) => void;
}) {
  const st = useStagger(rows.length);
  const flash = useFlashRows(rows.map((r) => r.id));
  const nameOf = useMemberName();
  // 容器查询按可用宽度收起次要列（停靠面板打开时主区只有 ~750px，固定列宽会把标题列挤没）
  return (
    <div className="req-table-wrap">
      <table className="table req-table" data-sort={sort?.sort}>
        <thead>
          <tr>
            <SortTh k="id" label="ID" width={84} sort={sort} onSort={onSort} />
            <th>需求</th>
            {full && (
              <th className="c-owner" style={{ width: 120 }}>
                负责人
              </th>
            )}
            <SortTh k="stage" label="阶段" className="c-stage" width={full ? 168 : 220} sort={sort} onSort={onSort} title="按完成的阶段占比排序" />
            {full && (
              <th className="c-node" style={{ width: 148 }}>
                当前节点
              </th>
            )}
            <th className="r" style={{ width: 56 }}>
              待办
            </th>
            <SortTh k="tokens" label="Token" className="r c-tokens" width={full ? 124 : 76} sort={sort} onSort={onSort} />
            {full && <SortTh k="cost" label="成本" className="r c-cost" width={76} sort={sort} onSort={onSort} />}
            {full && <SortTh k="intercepted" label="拦截" className="r c-quality" width={64} sort={sort} onSort={onSort} title={QUALITY_TITLE} />}
            {full && <SortTh k="updated" label="更新" className="r c-updated" width={84} sort={sort} onSort={onSort} />}
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
                {/* 极窄（手机）时阶段列收起，阶段放到标题下面一行 */}
                {full && (
                  <div className="req-stage-inline">
                    <StageCell r={r} />
                  </div>
                )}
                {!full && (
                  <div className="req-meta">
                    {r.owner && (
                      <>
                        <Avatar name={nameOf(r.owner)} id={r.owner} size={14} />
                        <span>{nameOf(r.owner)}</span>
                        <span className="dot-sep" />
                      </>
                    )}
                    <span title={fmtDateTime(r.updatedAt)}>
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
                      <Avatar name={nameOf(r.owner)} id={r.owner} size={20} />
                      <span className="truncate" title={nameOf(r.owner)}>{nameOf(r.owner)}</span>
                    </span>
                  )}
                </td>
              )}
              <td className="c-stage">
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
              <td className="r mono num c-tokens">
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
                  <CostCell r={r} />
                </td>
              )}
              {full && (
                <td className="r mono num c-quality" title={qualityTitle(r)}>
                  {r.quality?.intercepted ? r.quality.intercepted : <span className="faint">—</span>}
                </td>
              )}
              {full && (
                <td className="r faint c-updated" title={fmtDateTime(r.updatedAt)}>
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

/** 成本格：未上报写 —，只覆盖部分调用时写 ≥，悬停说明（与总览"累计 Token"同一套读法）。 */
function CostCell({ r }: { r: RequirementSummary }) {
  const cost = costOf(r.usage);
  return (
    <span className={cost.usd === undefined ? "faint" : undefined} title={cost.title}>
      {cost.text}
    </span>
  );
}

const qualityTitle = (r: RequirementSummary) =>
  r.quality ? `已校验 ${r.quality.verified} 项 · 拦下 ${r.quality.intercepted} 个问题` : "还没有校验记录";
