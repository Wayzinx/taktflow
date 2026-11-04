import { ListTodo } from 'lucide-react'
import { useAsync } from '../api'
import { PageHeader, useCrumbs } from '../components/layout'
import { EmptyState, ErrorState, SkeletonRows } from '../components/ui'
import { RequirementsTable } from './requirements-table'
import './overview.css'

export function RequirementsPage() {
  const q = useAsync((ds) => ds.requirements(), [])
  useCrumbs([{ label: '需求' }], [])
  if (q.error && !q.data) return <ErrorState error={q.error} onRetry={q.reload} />
  return (
    <div className="page fade-in">
      <PageHeader title="需求" sub={<>每个需求一个公共存放区 <span className="mono">.takt/workspaces/&lt;REQ&gt;/</span>，所有 Agent 和人从这里取、往这里写。</>} />
      <div className="card">
        {!q.data ? (
          <SkeletonRows rows={6} />
        ) : q.data.length === 0 ? (
          <EmptyState icon={ListTodo} title="还没有需求" hint={<>命令行创建：<span className="mono">takt req new "需求标题"</span></>} />
        ) : (
          <RequirementsTable rows={q.data} full />
        )}
      </div>
    </div>
  )
}
