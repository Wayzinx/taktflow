import { useState } from 'react'
import { Activity, CircleCheckBig, Coins, Inbox, OctagonAlert } from 'lucide-react'
import type { ProjectOverview, RequirementSummary } from '@taktflow/core'
import { useAsync } from '../api'
import { AttentionCard } from '../components/attention-card'
import { useCrumbs } from '../components/layout'
import { NewRequirementButton } from '../components/requirement-create/button'
import { StatCard, StatStrip } from '../components/stat-card'
import { CountUp, EmptyState, ErrorState, PageHeader, Segmented, Skeleton, SkeletonRows, useFlashRows, useStagger, useStewardSuggestions } from '../components/ui'
import { fmtCost, fmtTokens, totalTokens } from '../lib/format'
import { Link } from '../lib/router'
import { QualityStat } from './overview-quality'
import { SinceBanner } from './overview-since'
import { useRequirementRisks } from './requirements-risk'
import { RequirementsTable } from './requirements-table'
import './overview.css'

/** 整数读数：过渡中途也按整数显示（CountUp 默认格式会在中途露出小数）。 */

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

function Stats({ p, filter, onFilter }: { p: ProjectOverview; filter: Filter; onFilter: (f: Filter) => void }) {
  const running = p.requirements.filter((r) => r.stages.some((s) => s.status === 'running')).length
  const waiting = p.requirements.filter((r) => r.stages.some((s) => s.status === 'waiting_human')).length
  const tokens = totalTokens(p.totals.usage)
  const cacheRate = tokens ? Math.round(((p.totals.usage.cachedTokens ?? 0) / p.totals.usage.inputTokens) * 100) : 0
  const toggle = (f: Filter) => () => onFilter(filter === f ? 'all' : f)
  return (
    <StatStrip label="项目读数">
      <StatCard
        label="进行中"
        icon={<Activity />}
        value={<CountUp value={p.totals.active} from0 />}
        foot={<><b>{running}</b> 个在跑 · <b>{waiting}</b> 个等人</>}
        tone={running ? 'var(--st-running)' : undefined}
        onClick={toggle('active')}
        active={filter === 'active'}
        hint="只看进行中的需求"
      />
      <StatCard
        label="已交付"
        icon={<CircleCheckBig />}
        value={<CountUp value={p.totals.delivered} from0 />}
        foot={<>共 <b>{p.totals.requirements}</b> 个需求 · <b>{p.totals.runs}</b> 次运行</>}
        onClick={toggle('delivered')}
        active={filter === 'delivered'}
        hint="只看已交付的需求"
      />
      <StatCard
        label="阻塞"
        icon={<OctagonAlert />}
        value={<CountUp value={p.totals.blocked} from0 />}
        foot={<><b>{p.attention.length}</b> 项待办等人处理</>}
        tone={p.totals.blocked ? 'var(--st-failed)' : undefined}
        onClick={toggle('blocked')}
        active={filter === 'blocked'}
        hint="只看阻塞的需求"
      />
      <StatCard
        label="本周 Token / 成本"
        icon={<Coins />}
        value={
          <>
            <CountUp value={tokens} from0 format={(v) => fmtTokens(Math.round(v))} />
            <span className="stat-unit">
              <CountUp value={p.totals.usage.costUsd ?? 0} from0 format={fmtCost} />
            </span>
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

export function OverviewPage() {
  const q = useAsync((ds) => ds.project(), [])
  const risks = useRequirementRisks()
  const suggestions = useStewardSuggestions('overview')
  const [filter, setFilter] = useState<Filter>('all')
  useCrumbs([{ label: q.data?.name ?? '项目' }, { label: '总览' }], [q.data?.name])
  const attention = q.data?.attention ?? []
  const stA = useStagger(Math.min(attention.length, 10))
  const flashA = useFlashRows(attention.map((a) => a.requestId))
  if (q.error && !q.data) return <ErrorState error={q.error} onRetry={q.reload} />
  const p = q.data
  const rows = p ? p.requirements.filter((r) => filter === 'all' || r.status === filter) : []
  const titleOf = (id: string) => p?.requirements.find((r) => r.id === id)?.title
  const riskCount = [...risks.values()].reduce((n, l) => n + l.length, 0)
  return (
    <div className="page overview">
      <PageHeader
        eyebrow="总览"
        title={p?.name ?? <Skeleton w={160} h={20} />}
        description={p ? describe(p, riskCount) : <Skeleton w={360} h={12} style={{ marginTop: 6 }} />}
        actions={<NewRequirementButton />}
        suggestions={suggestions}
      />
      {!p ? (
        <OverviewSkeleton />
      ) : p.requirements.length === 0 ? (
        <div className="card">
          <EmptyState
            icon={Inbox}
            title="这个空间还没有需求"
            body="写下要做的事，管家会帮你选流程、补全验收标准，然后开始交付。"
            action={<NewRequirementButton label="写第一个需求" />}
            stewardAsk="帮我把这周要做的事整理成需求"
          />
        </div>
      ) : (
        <>
          <SinceBanner />
          <Stats p={p} filter={filter} onFilter={setFilter} />
          <div className="overview-grid">
            <section className="card">
              <div className="card-head">
                <span className="card-title">需求</span>
                <span className="faint num">{p.requirements.length}</span>
                <span className="spacer" />
                <Segmented<Filter>
                  value={filter}
                  onChange={setFilter}
                  size="sm"
                  ariaLabel="按状态筛选"
                  options={FILTERS.map((f) => ({ ...f, count: f.value === 'all' ? p.requirements.length : p.requirements.filter((r) => r.status === f.value).length }))}
                />
              </div>
              {rows.length ? (
                <RequirementsTable rows={rows} risks={risks} />
              ) : (
                <EmptyState compact icon={Inbox} title="这个状态下没有需求" body="换个筛选看看全部。" action={<button type="button" className="btn btn-sm" onClick={() => setFilter('all')}>看全部</button>} />
              )}
            </section>
            <section className="card attention-panel">
              <div className="card-head">
                <span className="card-title">待办</span>
                {attention.length > 0 && <span className="pending-pill num">{attention.length}</span>}
                <span className="spacer" />
                <Link to="/attention" className="btn btn-ghost btn-sm">
                  全部
                </Link>
              </div>
              {attention.length === 0 ? (
                <EmptyState compact icon={Inbox} title="没有等你处理的事" body="审批、澄清问题、门禁裁决会出现在这里。" />
              ) : (
                <div className="attention-panel-list">
                  {attention.map((a, i) => (
                    <div key={a.requestId} className={`${stA(i).className ?? ''} ${flashA(a.requestId)}`} style={stA(i).style}>
                      <AttentionCard item={a} reqTitle={titleOf(a.requirementId)} compact />
                    </div>
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

type Filter = 'all' | 'active' | 'blocked' | 'delivered'
const FILTERS: Array<{ value: Filter; label: string }> = [
  { value: 'all', label: '全部' },
  { value: 'active', label: '进行中' },
  { value: 'blocked', label: '阻塞' },
  { value: 'delivered', label: '已交付' },
]

/** 页头一句话：现在怎么样（而不是这页是什么）。 */
function describe(p: ProjectOverview, risks: number): string {
  const parts = [`${p.totals.requirements} 个需求，${p.totals.active} 个进行中`]
  if (p.attention.length) parts.push(`${p.attention.length} 项等你处理`)
  if (risks) parts.push(`${risks} 条风险`)
  if (!p.attention.length && !risks) parts.push('一切顺利')
  return parts.join('，')
}
