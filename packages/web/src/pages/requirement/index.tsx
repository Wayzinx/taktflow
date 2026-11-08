import { Activity, Bug, ChartNoAxesColumn, ClipboardCheck, FolderOpen, GitBranch, MessagesSquare, Network } from 'lucide-react'
import { useAsync } from '../../api'
import { useCrumbs } from '../../components/layout'
import { BudgetBar } from '../../components/budget-bar'
import { StageRail } from '../../components/stage-rail'
import type { RequirementDetail, RunDetail } from '@taktflow/core'
import { TierGlyph, TIER_LABEL } from '../../components/tier-glyph'
import { ErrorState, Skeleton, StatusDot, SuggestionChips, TabPanel, Tabs, useStewardSuggestions } from '../../components/ui'
import { Link, navigate, setQuery, useLocation } from '../../lib/router'
import { NODE_STATUS, RUN_STATUS } from '../../lib/status'
import { ActivityTab } from './activity-tab'
import { ArtifactsTab } from './artifacts-tab'
import { ChatTab } from './chat-tab'
import { Decisions } from './decisions'
import { DefectsTab } from './defects-tab'
import { RequirementHeader } from './header'
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
        还没有运行
        <span className="req-summary-sub">
          <Link to={`/req/${r.id}?tab=chat`}>去群聊让 Lead 开始</Link>
        </span>
      </div>
    )
  const st = run ? RUN_STATUS[run.run.status] : undefined
  return (
    <div className="req-summary">
      {st && <StatusDot tone={st.tone} />}
      最近一次运行{st ? st.label : <Skeleton w={48} h={12} style={{ marginLeft: 4 }} />}
      {sub}
    </div>
  )
}

export function RequirementPage({ id }: { id: string }) {
  const { query } = useLocation()
  const tab = query.get('tab') ?? 'artifacts'
  const q = useAsync((ds) => ds.requirement(id), [id])
  const r = q.data
  // 最近一次流水线运行：预算条与"需要你决策"用它的 budget
  const latest = useAsync((ds) => (r?.latestRunId ? ds.run(r.latestRunId) : Promise.resolve(undefined)), [r?.latestRunId])
  useCrumbs([{ label: '需求', to: '/requirements' }, { label: <span className="mono">{id}</span> }], [id])
  const suggestions = useStewardSuggestions('requirement', id)

  if (q.error && !r) return <ErrorState error={q.error} onRetry={q.reload} />

  return (
    <div className="page req-page">
      <header className="req-header cascade">
        <RequirementHeader id={id} detail={r} status={r ? <StatusLine r={r} run={latest.data} /> : <Skeleton w={280} h={14} style={{ marginTop: 10 }} />} onChanged={q.reload} />
        {suggestions.length > 0 && <SuggestionChips className="req-suggest" items={suggestions} context={[{ type: 'requirement', id, label: id }]} />}
        <div className="card req-stage-card">
          {r ? (
            <StageRail
              stages={r.stages}
              current={r.current}
              empty={r.latestRunId ? '最近的运行没有划分阶段' : '尚未运行'}
              onStage={r.latestRunId ? (sid) => navigate(`/run/${r.latestRunId}?stage=${encodeURIComponent(sid)}`) : undefined}
            />
          ) : (
            <Skeleton h={28} />
          )}
        </div>
        <Decisions requirementId={id} detail={r} run={latest.data} budget={latest.data?.budget} />
        <BudgetBar budget={latest.data?.budget} runId={r?.latestRunId} />
      </header>

      <Tabs
        value={tab}
        onChange={(t) => setQuery({ tab: t === 'artifacts' ? undefined : t, path: undefined, v: undefined, defect: undefined })}
        tabs={[
          { id: 'artifacts', label: '公共产物', icon: FolderOpen, count: r?.artifacts.length },
          { id: 'chat', label: '群聊', icon: MessagesSquare },
          { id: 'reviews', label: '评审', icon: ClipboardCheck },
          { id: 'runs', label: '运行', icon: GitBranch, count: r?.runs.length },
          { id: 'trace', label: '追溯', icon: Network },
          { id: 'metrics', label: '度量', icon: ChartNoAxesColumn },
          { id: 'defects', label: '缺陷', icon: Bug },
          { id: 'activity', label: '动态', icon: Activity },
        ]}
      />
      <TabPanel key={tab} className="req-tab-body">
        {tab === 'artifacts' && <ArtifactsTab id={id} detail={r} run={latest.data} />}
        {tab === 'chat' && <ChatTab id={id} detail={r} />}
        {tab === 'reviews' && <ReviewsTab id={id} />}
        {tab === 'runs' && <RunsTab runs={r?.runs} reqId={id} />}
        {tab === 'trace' && <TraceTab id={id} />}
        {tab === 'metrics' && <MetricsTab id={id} quality={r?.quality} />}
        {tab === 'defects' && <DefectsTab id={id} detail={r} />}
        {tab === 'activity' && <ActivityTab id={id} runs={r?.runs} />}
      </TabPanel>
    </div>
  )
}
