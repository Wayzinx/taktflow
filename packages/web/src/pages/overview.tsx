import { useState, type CSSProperties } from 'react'
import { Activity, CircleCheck, CircleCheckBig, Coins, Inbox, OctagonAlert } from 'lucide-react'
import type { ProjectOverview, RequirementSummary } from '@taktflow/core'
import { useAsync } from '../api'
import { AttentionCard } from '../components/attention-card'
import { useCrumbs } from '../components/layout'
import { NewRequirementButton } from '../components/requirement-create/button'
import { CountUp, EmptyState, ErrorState, PageHeader, Segmented, Skeleton, SkeletonRows, useFlashRows, useStagger, useStewardSuggestions } from '../components/ui'
import { StatTiles, type Tile } from '../components/viz'
import { fmtCost, fmtTokens, totalTokens } from '../lib/format'
import { Link } from '../lib/router'
import { qualityTile } from './overview-quality'
import { RequirementLanes } from './overview-lanes'
import { SinceBanner } from './overview-since'
import { useRequirementRisks } from './requirements-risk'
import './overview.css'

const SHARE_COLORS = ['var(--c-1)', 'var(--c-2)', 'var(--c-3)', 'var(--c-4)', 'var(--c-6)', 'var(--c-5)']

function TokenShare({ reqs }: { reqs: RequirementSummary[] }) {
  const items = reqs.filter((r) => totalTokens(r.usage) > 0)
  const total = items.reduce((s, r) => s + totalTokens(r.usage), 0)
  if (!total) return null
  return (
    <div className="share-bar" aria-label="按需求拆分">
      {items.map((r, i) => (
        <span key={r.id} title={`${r.id} ${r.title} · ${fmtTokens(totalTokens(r.usage))}`} style={{ flex: totalTokens(r.usage) / total, background: SHARE_COLORS[i % SHARE_COLORS.length] }} />
      ))}
    </div>
  )
}

/** 读数：进行中 / 阻塞 / 已交付可点（筛选下方泳道），Token 与质量只读。数字只在表达状态时着色。 */
function tilesOf(p: ProjectOverview, risks: number, filter: Filter, onFilter: (f: Filter) => void): Tile[] {
  const running = p.requirements.filter((r) => r.stages.some((s) => s.status === 'running')).length
  const waiting = p.requirements.filter((r) => r.stages.some((s) => s.status === 'waiting_human')).length
  const tokens = totalTokens(p.totals.usage)
  const cacheRate = tokens ? Math.round(((p.totals.usage.cachedTokens ?? 0) / p.totals.usage.inputTokens) * 100) : 0
  const toggle = (f: Filter) => () => onFilter(filter === f ? 'all' : f)
  return [
    { key: 'active', label: '进行中', icon: <Activity />, value: <CountUp value={p.totals.active} from0 />, tone: running ? 'running' : undefined, hint: <><b>{running}</b> 在跑 · <b>{waiting}</b> 等人</>, onClick: toggle('active'), active: filter === 'active', title: '只看进行中的需求' },
    { key: 'blocked', label: '阻塞', icon: <OctagonAlert />, value: <CountUp value={p.totals.blocked} from0 />, tone: p.totals.blocked ? 'failed' : undefined, hint: risks ? <><b>{risks}</b> 条风险</> : '没有风险', onClick: toggle('blocked'), active: filter === 'blocked', title: '只看阻塞的需求' },
    { key: 'delivered', label: '已交付', icon: <CircleCheckBig />, value: <CountUp value={p.totals.delivered} from0 />, hint: <>共 <b>{p.totals.requirements}</b> 个 · <b>{p.totals.runs}</b> 次运行</>, onClick: toggle('delivered'), active: filter === 'delivered', title: '只看已交付的需求' },
    { key: 'tokens', label: '累计 Token', icon: <Coins />, value: <CountUp value={tokens} from0 format={(v) => fmtTokens(Math.round(v))} />, unit: <CountUp value={p.totals.usage.costUsd ?? 0} from0 format={fmtCost} />, hint: <>缓存命中 <b>{cacheRate}%</b></>, children: <TokenShare reqs={p.requirements} />, title: '色段为各需求占比' },
    qualityTile(p.totals, p.requirements),
  ]
}

function OverviewSkeleton() {
  return (
    <>
      <div className="tiles">
        {[0, 1, 2, 3, 4].map((i) => (
          <div key={i} className="tile" style={{ '--n': 5 } as CSSProperties}>
            <Skeleton w={72} h={11} />
            <Skeleton w={56} h={26} />
            <Skeleton w={120} h={10} />
          </div>
        ))}
      </div>
      <div className="ov-main">
        <div className="card">
          <SkeletonRows rows={5} />
        </div>
        <div className="card">
          <SkeletonRows rows={2} gap={28} />
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
        description={p ? describe(p, riskCount) : <Skeleton w={200} h={12} style={{ marginTop: 6 }} />}
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
          <StatTiles label="项目读数" tiles={tilesOf(p, riskCount, filter, setFilter)} />
          <div className="ov-main">
            <section className="card ov-lanes">
              <div className="card-head">
                <span className="card-title">交付泳道</span>
                <span className="faint num">{rows.length}</span>
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
                <RequirementLanes rows={rows} risks={risks} />
              ) : (
                <EmptyState compact icon={Inbox} title="这个状态下没有需求" body="换个筛选看看全部。" action={<button type="button" className="btn btn-sm" onClick={() => setFilter('all')}>看全部</button>} />
              )}
            </section>
            <Decisions attention={attention} titleOf={titleOf} />
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

/** 等你决定：审批、澄清、门禁裁决；没有时只占一行，不放大空状态。 */
function Decisions({ attention, titleOf }: { attention: ProjectOverview['attention']; titleOf: (id: string) => string | undefined }) {
  const st = useStagger(Math.min(attention.length, 10))
  const flash = useFlashRows(attention.map((a) => a.requestId))
  return (
    <section className="card ov-decisions" data-empty={attention.length === 0 || undefined}>
      <div className="card-head">
        <span className="card-title">等你决定</span>
        {attention.length > 0 && <span className="pending-pill num">{attention.length}</span>}
        <span className="spacer" />
        <Link to="/attention" className="btn btn-ghost btn-sm">
          全部
        </Link>
      </div>
      {attention.length === 0 ? (
        <p className="ov-clear">
          <CircleCheck aria-hidden />
          都处理完了
          <span className="faint">审批、澄清、门禁裁决会出现在这里</span>
        </p>
      ) : (
        <div className="attention-panel-list">
          {attention.map((a, i) => (
            <div key={a.requestId} className={`${st(i).className ?? ''} ${flash(a.requestId)}`} style={st(i).style}>
              <AttentionCard item={a} reqTitle={titleOf(a.requirementId)} compact />
            </div>
          ))}
        </div>
      )}
    </section>
  )
}

/** 页头一句话：只说需要注意的（数字已经在读数里）。 */
function describe(p: ProjectOverview, risks: number): string {
  const parts: string[] = []
  if (p.attention.length) parts.push(`${p.attention.length} 项等你决定`)
  if (risks) parts.push(`${risks} 条风险`)
  return parts.length ? parts.join(' · ') : '一切顺利'
}
