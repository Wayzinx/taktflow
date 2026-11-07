import { useState } from 'react'
import { ListTodo, SearchX } from 'lucide-react'
import type { RequirementSummary } from '@taktflow/core'
import { useAsync } from '../api'
import { useCrumbs } from '../components/layout'
import { EmptyState, ErrorState, PageHeader, Segmented, Skeleton, SkeletonRows, useStewardSuggestions } from '../components/ui'
import { NewRequirementButton } from '../components/requirement-create/button'
import { useRequirementRisks } from './requirements-risk'
import { RequirementsTable } from './requirements-table'
import './overview.css'

type Filter = 'all' | 'active' | 'blocked' | 'delivered' | 'risk'

export function RequirementsPage() {
  const q = useAsync((ds) => ds.requirements(), [])
  const risks = useRequirementRisks()
  const suggestions = useStewardSuggestions('requirements')
  const [filter, setFilter] = useState<Filter>('all')
  useCrumbs([{ label: '需求' }], [])
  if (q.error && !q.data) return <ErrorState error={q.error} onRetry={q.reload} />
  const all = q.data ?? []
  const match = (r: RequirementSummary) => (filter === 'all' ? true : filter === 'risk' ? risks.has(r.id) : r.status === filter)
  const rows = all.filter(match)
  const active = all.filter((r) => r.status === 'active').length
  const count = (f: Filter) => all.filter((r) => (f === 'risk' ? risks.has(r.id) : r.status === f)).length
  return (
    <div className="page">
      <PageHeader
        title="需求"
        description={q.data ? (all.length ? `${all.length} 个需求，${active} 个进行中${risks.size ? `，${risks.size} 个有风险` : ''}` : '每个需求从这里开始交付') : <Skeleton w={220} h={12} style={{ marginTop: 6 }} />}
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
            <div className="card-head">
              <Segmented<Filter>
                value={filter}
                onChange={setFilter}
                size="sm"
                ariaLabel="按状态筛选"
                options={[
                  { value: 'all', label: '全部', count: all.length },
                  { value: 'active', label: '进行中', count: count('active') },
                  { value: 'blocked', label: '阻塞', count: count('blocked') },
                  { value: 'delivered', label: '已交付', count: count('delivered') },
                  ...(risks.size ? [{ value: 'risk' as const, label: '有风险', count: count('risk') }] : []),
                ]}
              />
            </div>
            {rows.length ? (
              <RequirementsTable rows={rows} full risks={risks} />
            ) : (
              <EmptyState compact icon={SearchX} title="这个筛选下没有需求" body="换个状态看看。" action={<button type="button" className="btn btn-sm" onClick={() => setFilter('all')}>看全部</button>} />
            )}
          </>
        )}
      </div>
    </div>
  )
}
