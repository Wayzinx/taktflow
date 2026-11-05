import { useState } from 'react'
import { Inbox } from 'lucide-react'
import { useAsync } from '../api'
import { AttentionCard } from '../components/attention-card'
import { PageHeader, useCrumbs } from '../components/layout'
import { EmptyState, ErrorState, Segmented, SkeletonRows, StatusBadge } from '../components/ui'
import { Link } from '../lib/router'
import { REQ_STATUS } from '../lib/status'
import './overview.css'

type View = 'pending' | 'done'

export function AttentionPage() {
  const [view, setView] = useState<View>('pending')
  const q = useAsync(async (ds) => {
    const [items, reqs] = await Promise.all([ds.attention(), ds.requirements()])
    return { items, reqs }
  }, [])
  useCrumbs([{ label: '待办' }], [])
  if (q.error && !q.data) return <ErrorState error={q.error} onRetry={q.reload} />
  const items = q.data?.items.filter((a) => (view === 'pending' ? !a.answeredAt : a.answeredAt)) ?? []
  const pendingCount = q.data?.items.filter((a) => !a.answeredAt).length ?? 0
  const groups = q.data ? q.data.reqs.map((r) => ({ r, items: items.filter((a) => a.requirementId === r.id) })).filter((g) => g.items.length) : []
  return (
    <div className="page attention-page fade-in">
      <PageHeader
        title="待办"
        sub="所有等人处理的事项：审批、回答澄清问题、门禁裁决、判决交人。处理结果写入审计日志，运行随后自动继续。"
        actions={
          <Segmented<View>
            value={view}
            onChange={setView}
            options={[
              { value: 'pending', label: `待处理 ${pendingCount}` },
              { value: 'done', label: '已处理' },
            ]}
          />
        }
      />
      {!q.data ? (
        <div className="card">
          <SkeletonRows rows={4} gap={30} />
        </div>
      ) : groups.length === 0 ? (
        <div className="card">
          <EmptyState icon={Inbox} title={view === 'pending' ? '全部处理完了' : '还没有处理过的事项'} hint={view === 'pending' ? '新的审批和问题会出现在这里，也会在左侧导航显示数量。' : undefined} />
        </div>
      ) : (
        <div className="att-groups">
          {groups.map(({ r, items }) => (
            <section key={r.id} className="card">
              <div className="card-head att-group-head">
                <Link to={`/req/${r.id}`} className="mono req-id">
                  {r.id}
                </Link>
                <Link to={`/req/${r.id}`} className="card-title">
                  {r.title}
                </Link>
                <StatusBadge meta={REQ_STATUS[r.status]} />
                <span className="spacer" />
                <span className="faint num att-group-count">{items.length} 项</span>
              </div>
              {items.map((a) => (
                <AttentionCard key={a.requestId} item={a} />
              ))}
            </section>
          ))}
        </div>
      )}
    </div>
  )
}
