import { Activity, ArrowUpRight, ChartNoAxesColumn, FolderOpen, GitBranch, Network, Play } from 'lucide-react'
import { useAsync } from '../../api'
import { useCrumbs } from '../../components/layout'
import { StageBar } from '../../components/stage-bar'
import { Avatar, AvatarStack, ErrorState, Skeleton, StatusBadge, Tabs } from '../../components/ui'
import { fmtCost, fmtRelative, fmtTokens, totalTokens } from '../../lib/format'
import { Link, setQuery, useLocation } from '../../lib/router'
import { REQ_STATUS } from '../../lib/status'
import { ActivityTab } from './activity-tab'
import { ArtifactsTab } from './artifacts-tab'
import { MetricsTab } from './metrics-tab'
import { RunsTab } from './runs-tab'
import { TraceTab } from './trace-tab'
import './requirement.css'

const LINK_LABEL: Record<string, string> = { meego: 'Meego', feishu: '飞书', github: 'GitHub', jira: 'Jira' }

export function RequirementPage({ id }: { id: string }) {
  const { query } = useLocation()
  const tab = query.get('tab') ?? 'artifacts'
  const q = useAsync((ds) => ds.requirement(id), [id])
  const r = q.data
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
      </header>

      <Tabs
        value={tab}
        onChange={(t) => setQuery({ tab: t === 'artifacts' ? undefined : t, path: undefined, v: undefined })}
        tabs={[
          { id: 'artifacts', label: '公共产物', icon: FolderOpen, count: r?.artifacts.length },
          { id: 'runs', label: '运行', icon: GitBranch, count: r?.runs.length },
          { id: 'trace', label: '追溯', icon: Network },
          { id: 'metrics', label: '度量', icon: ChartNoAxesColumn },
          { id: 'activity', label: '动态', icon: Activity },
        ]}
      />
      <div className="req-tab-body">
        {tab === 'artifacts' && <ArtifactsTab id={id} detail={r} />}
        {tab === 'runs' && <RunsTab runs={r?.runs} />}
        {tab === 'trace' && <TraceTab id={id} />}
        {tab === 'metrics' && <MetricsTab id={id} />}
        {tab === 'activity' && <ActivityTab id={id} runs={r?.runs} />}
      </div>
    </div>
  )
}
