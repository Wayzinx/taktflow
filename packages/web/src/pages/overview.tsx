import { useState } from 'react'
import { Activity, CircleCheckBig, Coins, Inbox, OctagonAlert } from 'lucide-react'
import type { ProjectOverview, RequirementSummary } from '@taktflow/core'
import { useAsync } from '../api'
import { AttentionCard } from '../components/attention-card'
import { PageHeader, useCrumbs } from '../components/layout'
import { StatCard, StatStrip } from '../components/stat-card'
import { EmptyState, ErrorState, Segmented, Skeleton, SkeletonRows } from '../components/ui'
import { fmtCost, fmtTokens, totalTokens } from '../lib/format'
import { Link } from '../lib/router'
import { QualityStat } from './overview-quality'
import { RequirementsTable } from './requirements-table'
import './overview.css'

const SHARE_COLORS = ['var(--c-1)', 'var(--c-2)', 'var(--c-3)', 'var(--c-4)', 'var(--c-6)', 'var(--c-5)']

function TokenShare({ reqs }: { reqs: RequirementSummary[] }) {
  const items = reqs.filter((r) => totalTokens(r.usage) > 0)
  const total = items.reduce((s, r) => s + totalTokens(r.usage), 0)
  if (!total) return null
  return (
    <div className="token-share" aria-label="按需求拆分">
      {items.map((r, i) => (
        <span key={r.id} title={`${r.id} ${r.title} · ${fmtTokens(totalTokens(r.usage))}`} style={{ flex: totalTokens(r.usage) / total, background: SHARE_COLORS[i % SHARE_COLORS.length] }} />
      ))}
    </div>
  )
}

function Stats({ p }: { p: ProjectOverview }) {
  const running = p.requirements.filter((r) => r.stages.some((s) => s.status === 'running')).length
  const waiting = p.requirements.filter((r) => r.stages.some((s) => s.status === 'waiting_human')).length
  const tokens = totalTokens(p.totals.usage)
  const cacheRate = tokens ? Math.round(((p.totals.usage.cachedTokens ?? 0) / p.totals.usage.inputTokens) * 100) : 0
  return (
    <StatStrip label="项目读数">
      <StatCard label="进行中" icon={<Activity />} value={p.totals.active} foot={<><b>{running}</b> 个在跑 · <b>{waiting}</b> 个等人</>} tone={running ? 'var(--st-running)' : undefined} />
      <StatCard label="已交付" icon={<CircleCheckBig />} value={p.totals.delivered} foot={<>共 <b>{p.totals.requirements}</b> 个需求 · <b>{p.totals.runs}</b> 次运行</>} />
      <StatCard label="阻塞" icon={<OctagonAlert />} value={p.totals.blocked} foot={<><b>{p.attention.length}</b> 项待办等人处理</>} tone={p.totals.blocked ? 'var(--st-failed)' : undefined} />
      <StatCard
        label="本周 Token / 成本"
        icon={<Coins />}
        value={
          <>
            {fmtTokens(tokens)}
            <span className="stat-unit">{fmtCost(p.totals.usage.costUsd)}</span>
          </>
        }
        foot={<>缓存命中 <b>{cacheRate}%</b> · 色段为各需求占比</>}
      >
        <TokenShare reqs={p.requirements} />
      </StatCard>
      <QualityStat totals={p.totals} requirements={p.requirements} />
    </StatStrip>
  )
}

function OverviewSkeleton() {
  return (
    <>
      <StatStrip label="项目读数">
        {[0, 1, 2, 3, 4].map((i) => (
          <div key={i} className="stat-cell stat-skeleton">
            <Skeleton w={72} h={11} />
            <Skeleton w={56} h={26} />
            <Skeleton w={120} h={10} />
          </div>
        ))}
      </StatStrip>
      <div className="overview-grid">
        <div className="card">
          <SkeletonRows rows={6} />
        </div>
        <div className="card">
          <SkeletonRows rows={3} gap={28} />
        </div>
      </div>
    </>
  )
}

type Filter = 'all' | 'active' | 'blocked' | 'delivered'

export function OverviewPage() {
  const q = useAsync((ds) => ds.project(), [])
  const [filter, setFilter] = useState<Filter>('all')
  useCrumbs([{ label: q.data?.name ?? '项目' }, { label: '总览' }], [q.data?.name])
  if (q.error && !q.data) return <ErrorState error={q.error} onRetry={q.reload} />
  const p = q.data
  const rows = p ? p.requirements.filter((r) => filter === 'all' || r.status === filter) : []
  const titleOf = (id: string) => p?.requirements.find((r) => r.id === id)?.title
  return (
    <div className="page overview fade-in">
      <PageHeader title={p?.name ?? <Skeleton w={160} h={20} />} sub={p ? p.description : <Skeleton w={360} h={12} style={{ marginTop: 6 }} />} />
      {!p ? (
        <OverviewSkeleton />
      ) : (
        <>
          <Stats p={p} />
          <div className="overview-grid">
            <section className="card">
              <div className="card-head">
                <span className="card-title">需求</span>
                <span className="faint num">{p.requirements.length}</span>
                <span className="spacer" />
                <Segmented<Filter>
                  value={filter}
                  onChange={setFilter}
                  options={[
                    { value: 'all', label: '全部' },
                    { value: 'active', label: '进行中' },
                    { value: 'blocked', label: '阻塞' },
                    { value: 'delivered', label: '已交付' },
                  ]}
                />
              </div>
              {rows.length ? <RequirementsTable rows={rows} /> : <EmptyState compact icon={Inbox} title="没有符合条件的需求" hint="换个筛选条件试试。" />}
            </section>
            <section className="card attention-panel">
              <div className="card-head">
                <span className="card-title">待办</span>
                {p.attention.length > 0 && <span className="pending-pill num">{p.attention.length}</span>}
                <span className="spacer" />
                <Link to="/attention" className="btn btn-ghost btn-sm">
                  全部
                </Link>
              </div>
              {p.attention.length === 0 ? (
                <EmptyState compact icon={Inbox} title="没有等你处理的事" hint="审批、澄清问题、门禁裁决会出现在这里。" />
              ) : (
                <div className="attention-panel-list">
                  {p.attention.map((a) => (
                    <AttentionCard key={a.requestId} item={a} reqTitle={titleOf(a.requirementId)} compact />
                  ))}
                </div>
              )}
            </section>
          </div>
        </>
      )}
    </div>
  )
}
