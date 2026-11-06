import { Activity, ArrowUpRight, ChartNoAxesColumn, ClipboardCheck, FolderOpen, GitBranch, MessagesSquare, Network, Play } from 'lucide-react'
import { useAsync } from '../../api'
import { useCrumbs } from '../../components/layout'
import { BudgetBar } from '../../components/budget-bar'
import { StageBar } from '../../components/stage-bar'
import type { RequirementDetail, RunDetail } from '@taktflow/core'
import { TierGlyph, TIER_LABEL } from '../../components/tier-glyph'
import { Avatar, AvatarStack, ErrorState, Skeleton, StatusBadge, StatusDot, Tabs } from '../../components/ui'
import { fmtCost, fmtRelative, fmtTokens, totalTokens } from '../../lib/format'
import { Link, setQuery, useLocation } from '../../lib/router'
import { NODE_STATUS, REQ_STATUS, RUN_STATUS } from '../../lib/status'
import { ActivityTab } from './activity-tab'
import { ArtifactsTab } from './artifacts-tab'
import { ChatTab } from './chat-tab'
import { Decisions } from './decisions'
import { MetricsTab } from './metrics-tab'
import { ReviewsTab } from './reviews-tab'
import { RunsTab } from './runs-tab'
import { TraceTab } from './trace-tab'
import './requirement.css'

const CURRENT_VERB: Record<string, string> = { running: '正在', waiting_human: '等你处理', blocked: '卡在', failed: '卡在', stale: '需要重跑' }

/** 一句话状态（docs/design/19 §9）：现在在哪、在干什么、要不要你出手。 */
function StatusLine({ r, run }: { r: RequirementDetail; run?: RunDetail }) {
  const stageIdx = r.stages.findIndex((s) => s.id === r.stage)
  const stage = stageIdx >= 0 ? r.stages[stageIdx] : undefined
  const tier = r.tier ?? run?.run.route?.tier
  const sub = (
    <span className="req-summary-sub">
      {stage && (
        <>
          {stage.title} · 第 {stageIdx + 1} / {r.stages.length} 阶段
        </>
      )}
      {tier && (
        <>
          {stage && ' · '}
          <TierGlyph tier={tier} size={14} label={false} /> {TIER_LABEL[tier].title}
        </>
      )}
      {r.pendingAttention > 0 && <> · {r.pendingAttention} 项待你决策</>}
    </span>
  )
  if (r.status === 'delivered')
    return (
      <div className="req-summary">
        <StatusDot tone="success" />
        已交付，共 {r.runs.length} 次运行
      </div>
    )
  const c = r.current
  if (c) {
    const tone = NODE_STATUS[c.status].tone
    return (
      <div className="req-summary">
        <span>
          <StatusDot tone={tone} pulse={c.status === 'running'} /> {CURRENT_VERB[c.status] ?? NODE_STATUS[c.status].label}{' '}
          <Link to={`/run/${c.runId}?node=${encodeURIComponent(c.nodeId)}`}>{c.title}</Link>
        </span>
        {sub}
      </div>
    )
  }
  if (!r.latestRunId)
    return (
      <div className="req-summary">
        <StatusDot tone="pending" />
        还没有运行，在群聊里告诉 Lead 开始
      </div>
    )
  const st = run ? RUN_STATUS[run.run.status] : undefined
  return (
    <div className="req-summary">
      {st && <StatusDot tone={st.tone} />}
      最近一次运行{st ? st.label : '加载中'}
      {sub}
    </div>
  )
}

const LINK_LABEL: Record<string, string> = { meego: 'Meego', feishu: '飞书', github: 'GitHub', jira: 'Jira' }

export function RequirementPage({ id }: { id: string }) {
  const { query } = useLocation()
  const tab = query.get('tab') ?? 'artifacts'
  const q = useAsync((ds) => ds.requirement(id), [id])
  const r = q.data
  // 最近一次流水线运行：预算条与"需要你决策"用它的 budget
  const latest = useAsync((ds) => (r?.latestRunId ? ds.run(r.latestRunId) : Promise.resolve(undefined)), [r?.latestRunId])
  useCrumbs([{ label: '需求', to: '/requirements' }, { label: <span className="mono">{id}</span> }], [id])

  if (q.error && !r) return <ErrorState error={q.error} onRetry={q.reload} />

  return (
    <div className="page req-page fade-in">
      <header className="req-header">
        <div className="req-header-top">
          <span className="req-id-chip mono">{id}</span>
          {r ? <StatusBadge meta={REQ_STATUS[r.status]} /> : <Skeleton w={56} h={20} r={10} />}
          {r?.links.map((l) => (
            <a key={l.url} className="chip" href={l.url} target="_blank" rel="noreferrer">
              <ArrowUpRight />
              {LINK_LABEL[l.type] ?? l.type}
              {l.title && <span className="faint">· {l.title}</span>}
            </a>
          ))}
          <span style={{ flex: 1 }} />
          {r?.members && <AvatarStack names={r.members} />}
          {r?.latestRunId && (
            <Link to={`/run/${r.latestRunId}`} className="btn btn-sm">
              <Play />
              最近运行
            </Link>
          )}
        </div>
        <h1 className="req-h1">{r ? r.title : <Skeleton w={320} h={24} />}</h1>
        {r ? <StatusLine r={r} run={latest.data} /> : <Skeleton w={280} h={14} style={{ marginTop: 10 }} />}
        <div className="req-facts">
          {r ? (
            <>
              {r.owner && (
                <span className="req-fact">
                  <Avatar name={r.owner} size={16} />
                  {r.owner}
                </span>
              )}
              <span className="req-fact">创建于 {fmtRelative(r.createdAt)}</span>
              <span className="req-fact">更新于 {fmtRelative(r.updatedAt)}</span>
              <span className="req-fact">
                <span className="mono">{fmtTokens(totalTokens(r.usage))}</span> tokens · <span className="mono">{fmtCost(r.usage.costUsd)}</span>
              </span>
              <span className="req-fact">
                公共存放区 <span className="mono">.takt/workspaces/{id}/</span>
              </span>
            </>
          ) : (
            <Skeleton w={420} h={12} />
          )}
        </div>
        <div className="card req-stage-card">{r ? <StageBar stages={r.stages} variant="full" /> : <Skeleton h={28} />}</div>
        <Decisions requirementId={id} detail={r} run={latest.data} budget={latest.data?.budget} />
        <BudgetBar budget={latest.data?.budget} runId={r?.latestRunId} />
      </header>

      <Tabs
        value={tab}
        onChange={(t) => setQuery({ tab: t === 'artifacts' ? undefined : t, path: undefined, v: undefined })}
        tabs={[
          { id: 'artifacts', label: '公共产物', icon: FolderOpen, count: r?.artifacts.length },
          { id: 'chat', label: '群聊', icon: MessagesSquare },
          { id: 'reviews', label: '评审', icon: ClipboardCheck },
          { id: 'runs', label: '运行', icon: GitBranch, count: r?.runs.length },
          { id: 'trace', label: '追溯', icon: Network },
          { id: 'metrics', label: '度量', icon: ChartNoAxesColumn },
          { id: 'activity', label: '动态', icon: Activity },
        ]}
      />
      <div className="req-tab-body">
        {tab === 'artifacts' && <ArtifactsTab id={id} detail={r} run={latest.data} />}
        {tab === 'chat' && <ChatTab id={id} detail={r} />}
        {tab === 'reviews' && <ReviewsTab id={id} />}
        {tab === 'runs' && <RunsTab runs={r?.runs} />}
        {tab === 'trace' && <TraceTab id={id} />}
        {tab === 'metrics' && <MetricsTab id={id} quality={r?.quality} />}
        {tab === 'activity' && <ActivityTab id={id} runs={r?.runs} />}
      </div>
    </div>
  )
}
