import { ListTodo, Search, SearchX, UserRound } from 'lucide-react'
import type { RequirementSummary } from '@taktflow/core'
import { useAsync, useMemberName } from '../api'
import { useCrumbs } from '../components/layout'
import { EmptyState, ErrorState, PageHeader, Segmented, Skeleton, SkeletonRows, useStewardSuggestions } from '../components/ui'
import { NewRequirementButton } from '../components/requirement-create/button'
import { actingUser } from '../lib/acting-user'
import { setQuery, useLocation } from '../lib/router'
import { readView, sortPatch, sortRequirements, matchText, type ReqFilter } from './requirements-query'
import { useSpaceRisks } from './requirements-risk'
import { RequirementsTable } from './requirements-table'
import './overview.css'

export function RequirementsPage() {
  const q = useAsync((ds) => ds.requirements(), [])
  const viewer = useAsync((ds) => ds.me().catch(() => undefined), [])
  const risks = useSpaceRisks()
  const suggestions = useStewardSuggestions('requirements')
  const nameOf = useMemberName()
  const { query } = useLocation()
  const view = readView(query)
  useCrumbs([{ label: '需求' }], [])
  if (q.error && !q.data) return <ErrorState error={q.error} onRetry={q.reload} />
  const all = q.data ?? []
  // "我"与待办页"我是"同一个人：选过就用选的，否则用服务端缺省身份
  const meId = actingUser() ?? viewer.data?.id
  const inStatus = (r: RequirementSummary, f: ReqFilter) => f === 'all' || (f === 'risk' ? risks.byRequirement.has(r.id) : r.status === f)
  // 分段计数在"我负责的"与搜索之后算：各状态加起来等于"全部"
  const base = all.filter((r) => (!view.mine || (!!meId && r.owner === meId)) && matchText(r, view.text))
  const rows = sortRequirements(base.filter((r) => inStatus(r, view.filter)), view.sort, view.order)
  const count = (f: ReqFilter) => base.filter((r) => inStatus(r, f)).length
  const active = all.filter((r) => r.status === 'active').length
  const blocked = all.filter((r) => r.status === 'blocked').length
  const mineCount = meId ? all.filter((r) => r.owner === meId).length : 0
  const setFilter = (f: ReqFilter) => setQuery({ status: f === 'all' ? undefined : f })
  const narrowed = view.filter !== 'all' || view.mine || !!view.text
  return (
    <div className="page">
      <PageHeader
        title="需求"
        description={q.data ? (all.length ? `${all.length} 个需求，${active} 个进行中${blocked ? `，${blocked} 个阻塞` : ''}${risks.byRequirement.size ? `，${risks.byRequirement.size} 个有风险` : ''}` : '每个需求从这里开始交付') : <Skeleton w={220} h={12} style={{ marginTop: 6 }} />}
        actions={<NewRequirementButton />}
        suggestions={suggestions}
      />
      <div className="card">
        {!q.data ? (
          <SkeletonRows rows={6} />
        ) : all.length === 0 ? (
          <EmptyState
            icon={ListTodo}
            title="还没有需求"
            body="写下要做的事，选好流程就能开始交付。"
            action={<NewRequirementButton label="新建需求" />}
            stewardAsk="帮我把这周要做的事拆成几个需求"
          />
        ) : (
          <>
            <div className="card-head req-toolbar">
              <Segmented<ReqFilter>
                value={view.filter}
                onChange={setFilter}
                size="sm"
                ariaLabel="按状态筛选"
                options={[
                  { value: 'all', label: '全部', count: base.length },
                  { value: 'active', label: '进行中', count: count('active') },
                  { value: 'blocked', label: '阻塞', count: count('blocked') },
                  { value: 'delivered', label: '已交付', count: count('delivered') },
                  { value: 'draft', label: '草稿', count: count('draft') },
                  ...(risks.byRequirement.size || view.filter === 'risk' ? [{ value: 'risk' as const, label: '有风险', count: count('risk') }] : []),
                ]}
              />
              <span className="spacer" />
              <button
                type="button"
                className="btn btn-sm req-mine"
                aria-pressed={view.mine}
                disabled={!meId}
                title={meId ? `只看负责人是 ${nameOf(meId)} 的需求（身份与待办页"我是"一致）` : '还不知道你是谁：去待办页选"我是"'}
                onClick={() => setQuery({ mine: view.mine ? undefined : '1' })}
              >
                <UserRound />
                我负责的
                <span className="num faint">{mineCount}</span>
              </button>
              <label className="req-search">
                <Search aria-hidden />
                <input className="input" type="search" placeholder="搜索 ID 或标题" aria-label="搜索需求" value={view.text} onChange={(e) => setQuery({ q: e.target.value || undefined })} />
              </label>
            </div>
            {rows.length ? (
              <RequirementsTable rows={rows} full risks={risks.byRequirement} sort={view} onSort={(key) => setQuery(sortPatch(view, key))} />
            ) : (
              <EmptyState
                compact
                icon={SearchX}
                title="这个筛选下没有需求"
                body={view.mine ? '你负责的需求里没有符合条件的。' : '换个状态或搜索词看看。'}
                action={narrowed ? <button type="button" className="btn btn-sm" onClick={() => setQuery({ status: undefined, mine: undefined, q: undefined })}>看全部</button> : undefined}
              />
            )}
          </>
        )}
      </div>
    </div>
  )
}
