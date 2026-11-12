import { useState, type CSSProperties } from 'react'
import { Activity, CircleCheckBig, Coins, Inbox, OctagonAlert, TriangleAlert } from 'lucide-react'
import type { ProjectOverview, RequirementSummary } from '@taktflow/core'
import { useAsync } from '../api'
import { AttentionCard } from '../components/attention-card'
import { useCrumbs } from '../components/layout'
import { NewRequirementButton } from '../components/requirement-create/button'
import { CountUp, EmptyState, ErrorState, PageHeader, Segmented, Skeleton, SkeletonRows, useFlashRows, useStagger, useStewardSuggestions } from '../components/ui'
import { Sparkline, StatTiles, type Tile } from '../components/viz'
import { costOf, fmtCost, fmtShare, fmtTokens, totalTokens } from '../lib/format'
import { Link } from '../lib/router'
import { qualityTile } from './overview-quality'
import { RequirementLanes, currentText } from './overview-lanes'
import { SinceBanner } from './overview-since'
import { describeOverview, isStuck } from './overview-status'
import { RiskList, useSpaceRisks, type SpaceRisks } from './requirements-risk'
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

/** 读数：进行中 / 阻塞 / 风险 / 已交付可点（筛选下方泳道），Token 与质量只读。数字只在表达状态时着色。 */
function tilesOf(p: ProjectOverview, risks: SpaceRisks, filter: Filter, onFilter: (f: Filter) => void): Tile[] {
  const running = p.requirements.filter((r) => r.stages.some((s) => s.status === 'running')).length
  const waiting = p.requirements.filter((r) => r.stages.some((s) => s.status === 'waiting_human')).length
  const stuck = p.requirements.filter(isStuck).length
  const tokens = totalTokens(p.totals.usage)
  const cost = costOf(p.totals.usage)
  // 缓存读取 ÷（输入 + 缓存读取）：Claude 系的输入不含缓存读取，直接除以输入会超过 100%
  const cached = p.totals.usage.cachedTokens ?? 0
  const cacheRate = cached ? Math.round((cached / (p.totals.usage.inputTokens + cached)) * 100) : 0
  const toggle = (f: Filter) => () => onFilter(filter === f ? 'all' : f)
  // 14 天趋势：只在最近有过活动时画（全是 0 的平线没有信息）；每个点悬停写明哪天、几次运行、多少 Token
  const daily = p.totals.daily ?? []
  const active = daily.some((d) => d.runs > 0)
  const points = daily.map((d) => `${d.day.slice(5)} · ${d.runs} 次运行 · ${fmtTokens(d.tokens)} Token`)
  const runSpark = active ? <span className="ov-run-trend"><Sparkline values={daily.map((d) => d.runs)} points={points} label={`近 ${daily.length} 天每日运行次数（按运行开始日）`} /><span>近 {daily.length} 天运行</span></span> : undefined
  const tokenSpark = active ? <Sparkline values={daily.map((d) => d.tokens)} points={points} label={`近 ${daily.length} 天每日 Token（按运行开始日）`} /> : undefined
  const riskCount = risks.all.length
  return [
    { key: 'active', label: '进行中', icon: <Activity />, value: <CountUp value={p.totals.active} from0 />, tone: running ? 'running' : undefined, hint: <><b>{running}</b> 在跑 · <b>{waiting}</b> 等人</>, onClick: toggle('active'), active: filter === 'active', title: '只看进行中的需求' },
    { key: 'blocked', label: '阻塞', icon: <OctagonAlert />, value: <CountUp value={p.totals.blocked} from0 />, tone: p.totals.blocked ? 'failed' : undefined, hint: !p.totals.blocked ? '没有阻塞' : stuck ? <><b>{stuck}</b> 个没有待办，没人被叫来处理</> : '都在等人处理', onClick: toggle('blocked'), active: filter === 'blocked', title: '只看阻塞的需求' },
    {
      key: 'risks',
      label: '风险',
      icon: <TriangleAlert />,
      // 风险接口比项目数据慢：拿到之前只放骨架，不先说"没有风险"
      value: risks.loading ? <Skeleton w={28} h={26} /> : risks.failed ? '—' : <CountUp value={riskCount} from0 />,
      tone: riskCount ? (risks.all.some((r) => r.level === 'high') ? 'failed' : 'waiting') : undefined,
      hint: risks.loading ? <Skeleton w={84} h={10} /> : risks.failed ? '风险暂时读不到' : !riskCount ? '没有风险' : risks.space.length ? <><b>{risks.space.length}</b> 条与需求无关</> : <>涉及 <b>{risks.byRequirement.size}</b> 个需求</>,
      onClick: toggle('risk'),
      active: filter === 'risk',
      title: '只看有风险的需求；全部风险（含与需求无关的）列在右侧，点开看依据',
    },
    { key: 'delivered', label: '已交付', icon: <CircleCheckBig />, value: <CountUp value={p.totals.delivered} from0 />, hint: <>共 <b>{p.totals.requirements}</b> 个 · <b>{p.totals.runs}</b> 次运行</>, spark: runSpark, onClick: toggle('delivered'), active: filter === 'delivered', title: '只看已交付的需求' },
    {
      key: 'tokens',
      label: '累计 Token',
      icon: <Coins />,
      value: <CountUp value={tokens} from0 format={(v) => fmtTokens(Math.round(v))} />,
      // 成本未上报不当 $0；只覆盖部分调用时写 ≥ 并给出覆盖率
      unit: cost.usd === undefined ? (tokens ? <span title={cost.title}>成本未上报</span> : undefined) : <span title={cost.title}><CountUp value={cost.usd} from0 format={(v) => `${cost.coverage === undefined ? '' : '≥'}${fmtCost(v)}`} /></span>,
      // 成本只覆盖部分 Token 时覆盖率放在前面（格子窄时后面的会被截断）
      hint: (
        <>
          {cost.coverage !== undefined && <span title={cost.title}>成本只覆盖 <b>{fmtShare(cost.coverage)}</b> · </span>}
          <span title="缓存读取 ÷（输入 + 缓存读取）">缓存命中 <b>{cacheRate}%</b></span>
        </>
      ),
      spark: tokenSpark,
      children: <TokenShare reqs={p.requirements} />,
      title: '色段为各需求占比',
    },
    qualityTile(p.totals, p.requirements),
  ]
}

function OverviewSkeleton() {
  return (
    <>
      <div className="tiles">
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <div key={i} className="tile" style={{ '--n': 6 } as CSSProperties}>
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
  const risks = useSpaceRisks()
  const space = useAsync((ds) => ds.space(), [])
  const suggestions = useStewardSuggestions('overview')
  const [filter, setFilter] = useState<Filter>('all')
  useCrumbs([{ label: q.data?.name ?? '项目' }, { label: '总览' }], [q.data?.name])
  const attention = q.data?.attention ?? []
  if (q.error && !q.data) return <ErrorState error={q.error} onRetry={q.reload} />
  const p = q.data
  const match = (r: RequirementSummary) => filter === 'all' || (filter === 'risk' ? risks.byRequirement.has(r.id) : r.status === filter)
  const rows = p ? p.requirements.filter(match) : []
  const titleOf = (id: string) => p?.requirements.find((r) => r.id === id)?.title
  const said = p && describeOverview(p, risks, space.data?.workflows.length)
  return (
    <div className="page overview">
      <PageHeader
        eyebrow="总览"
        title={p?.name ?? <Skeleton w={160} h={20} />}
        description={said ?? <Skeleton w={200} h={12} style={{ marginTop: 6 }} />}
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
          {risks.all.length > 0 && <RiskList risks={risks.all} />}
        </div>
      ) : (
        <>
          <SinceBanner />
          <StatTiles label="项目读数" tiles={tilesOf(p, risks, filter, setFilter)} />
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
                  options={FILTERS.filter((f) => f.value !== 'risk' || risks.byRequirement.size || filter === 'risk').map((f) => ({ ...f, count: f.value === 'all' ? p.requirements.length : p.requirements.filter(f.value === 'risk' ? (r) => risks.byRequirement.has(r.id) : (r) => r.status === f.value).length }))}
                />
              </div>
              {rows.length ? (
                <RequirementLanes rows={rows} risks={risks.byRequirement} />
              ) : filter === 'risk' && risks.space.length ? (
                <EmptyState compact icon={Inbox} title="没有需求带风险" body={`${risks.space.length} 条风险与需求无关，列在右侧「风险」里。`} action={<button type="button" className="btn btn-sm" onClick={() => setFilter('all')}>看全部</button>} />
              ) : (
                <EmptyState compact icon={Inbox} title="这个状态下没有需求" body="换个筛选看看全部。" action={<button type="button" className="btn btn-sm" onClick={() => setFilter('all')}>看全部</button>} />
              )}
            </section>
            <Decisions attention={attention} titleOf={titleOf} stuck={p.requirements.filter(isStuck)} risks={risks} />
          </div>
        </>
      )}
    </div>
  )
}

type Filter = 'all' | 'active' | 'blocked' | 'delivered' | 'risk'
const FILTERS: Array<{ value: Filter; label: string }> = [
  { value: 'all', label: '全部' },
  { value: 'active', label: '进行中' },
  { value: 'blocked', label: '阻塞' },
  { value: 'delivered', label: '已交付' },
  { value: 'risk', label: '有风险' },
]

/**
 * 等你决定：审批、澄清、门禁裁决；没有时只占一行，不放大空状态。
 * 阻塞却没有待办的需求和全部风险（含与需求无关的空间级风险）跟在后面，每条都能点到依据。
 */
function Decisions({ attention, titleOf, stuck, risks }: { attention: ProjectOverview['attention']; titleOf: (id: string) => string | undefined; stuck: RequirementSummary[]; risks: SpaceRisks }) {
  const st = useStagger(Math.min(attention.length, 10))
  const flash = useFlashRows(attention.map((a) => a.requestId))
  return (
    <section className="card ov-decisions" data-empty={(attention.length === 0 && stuck.length === 0 && risks.all.length === 0) || undefined}>
      <div className="card-head">
        <span className="card-title">等你决定</span>
        {attention.length > 0 && <span className="pending-pill num">{attention.length}</span>}
        <span className="spacer" />
        <Link to="/attention" className="btn btn-ghost btn-sm">
          全部
        </Link>
      </div>
      {attention.length === 0 ? (
        stuck.length === 0 && (
          <p className="ov-clear">
            没有待处理的审批或问题
            <span className="faint">审批、澄清、门禁裁决会出现在这里</span>
          </p>
        )
      ) : (
        <div className="attention-panel-list">
          {attention.map((a, i) => (
            <div key={a.requestId} className={`${st(i).className ?? ''} ${flash(a.requestId)}`} style={st(i).style}>
              <AttentionCard item={a} reqTitle={titleOf(a.requirementId)} compact />
            </div>
          ))}
        </div>
      )}
      {stuck.length > 0 && (
        <div className="ov-stuck">
          <div className="ov-sub-head">
            <OctagonAlert aria-hidden />
            {stuck.length} 个阻塞需求没有待办
          </div>
          <ul className="ov-sub-list">
            {stuck.map((r) => (
              <li key={r.id}>
                <Link to={`/req/${r.id}`} className="ov-sub-item">
                  <span className="mono faint">{r.id}</span>
                  <span className="truncate">{r.title}</span>
                  <span className="ov-sub-note">{currentText(r).text}</span>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}
      {risks.all.length > 0 && <RiskList risks={risks.all} />}
    </section>
  )
}
