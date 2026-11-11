import type { RequirementSummary } from '@taktflow/core'
import { useMemberName } from '../api'
import { Avatar, StatusDot, useFlashRows, useStagger, vtName } from '../components/ui'
import { TierGlyph, TIER_LABEL } from '../components/tier-glyph'
import { LANE_LABEL, LaneTrack, RunBars, cellsOf, currentCell } from '../components/viz'
import { fmtRelative, fmtTokens, totalTokens } from '../lib/format'
import { navigate } from '../lib/router'
import { REQ_STATUS } from '../lib/status'
import { RiskMark, type RiskIndex } from './requirements-risk'

/** 当前格的一句话：等人优先说"等你"，全部完成说"已完成"，没跑过说"尚未运行"。 */
export function currentText(r: RequirementSummary): { text: string; tone?: 'waiting' | 'running' | 'failed' | 'success' } {
  if (!r.stages.length) return { text: r.latestRunId ? '未分阶段' : '尚未运行' }
  const cells = cellsOf(r.stages)
  const cur = currentCell(cells)
  if (!cur) return { text: '已完成', tone: 'success' }
  if (cur.status === 'waiting') return { text: `${cur.label} · 等你`, tone: 'waiting' }
  if (cur.status === 'running') return { text: `${cur.label} · ${LANE_LABEL.running}`, tone: 'running' }
  if (cur.status === 'failed') return { text: `${cur.label} · 失败`, tone: 'failed' }
  return { text: `下一步：${cur.label}` }
}

/** 表格里的阶段格：泳道在上、当前一句话在下，列再窄也不截成"研.."。 */
export function StageCell({ r }: { r: RequirementSummary }) {
  const cur = currentText(r)
  return (
    <span className="stage-cell">
      {r.stages.length > 0 && <LaneTrack cells={cellsOf(r.stages)} size="sm" />}
      <span className="rl-cur truncate" data-tone={cur.tone} title={cur.text}>
        {cur.text}
      </span>
    </span>
  )
}

/**
 * 交付泳道（总览的视觉主角，docs/design/24）：一需求一行，格子 = 流水线阶段，状态只来自运行事件。
 * 宽容器三列（标题 | 泳道 + 当前 | 等你 / Token），各行共用列宽（subgrid），右侧内容多少不同也不会把泳道推歪；
 * 窄容器（停靠面板打开时）泳道换到标题下面，任何宽度都不挤标题。
 */
export function RequirementLanes({ rows, risks }: { rows: RequirementSummary[]; risks?: RiskIndex }) {
  const st = useStagger(rows.length)
  const flash = useFlashRows(rows.map((r) => r.id))
  const nameOf = useMemberName()
  return (
    <div className="req-lanes-box">
      <ul className="req-lanes">
        {rows.map((r, i) => {
          const cur = currentText(r)
          const tokens = totalTokens(r.usage)
          const open = () => navigate(`/req/${r.id}`)
          return (
            <li
              key={r.id}
              data-steward-anchor={r.id}
              className={`req-lane ${st(i).className ?? ''} ${flash(r.id)}`}
              style={st(i).style}
              role="link"
              tabIndex={0}
              aria-label={`${r.id} ${r.title}，${REQ_STATUS[r.status].label}，${cur.text}`}
              onClick={open}
              onKeyDown={(e) => e.key === 'Enter' && open()}
            >
              <span className="rl-main">
                <span className="rl-title-row">
                  <StatusDot tone={REQ_STATUS[r.status].tone} pulse={r.stages.some((s) => s.status === 'running')} />
                  <span className="rl-title" style={{ viewTransitionName: vtName('req', r.id) }}>
                    {r.title}
                  </span>
                  <RiskMark risks={risks?.get(r.id)} reqId={r.id} />
                </span>
                <span className="rl-meta">
                  <span className="mono">{r.id}</span>
                  {r.tier && (
                    <span className="rl-tier" title={`${TIER_LABEL[r.tier].title}：${TIER_LABEL[r.tier].hint}`}>
                      <TierGlyph tier={r.tier} size={11} label={false} />
                      {r.tier}
                    </span>
                  )}
                  {r.owner && (
                    <span className="rl-owner" title={nameOf(r.owner)}>
                      <Avatar name={nameOf(r.owner)} id={r.owner} size={14} />
                      <span className="truncate">{nameOf(r.owner)}</span>
                    </span>
                  )}
                  <span title={r.updatedAt}>{fmtRelative(r.updatedAt)}</span>
                </span>
              </span>
              <span className="rl-progress">
                {r.stages.length > 0 && <LaneTrack cells={cellsOf(r.stages)} />}
                <span className="rl-cur" data-tone={cur.tone}>
                  {cur.text}
                </span>
              </span>
              <span className="rl-side">
                {r.pendingAttention > 0 && <span className="rl-wait num">等你 {r.pendingAttention}</span>}
                {(r.recentRuns?.length ?? 0) > 1 && <RunBars runs={r.recentRuns!} />}
                <span className="rl-tokens mono num" title="累计 Token">
                  {tokens ? fmtTokens(tokens) : '—'}
                </span>
              </span>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
