import { useState } from 'react'
import { History, Inbox, UserRound } from 'lucide-react'
import type { AttentionItem, SpaceMember } from '@taktflow/core'
import { useAsync } from '../api'
import { AttentionCard } from '../components/attention-card'
import { PageHeader, useCrumbs } from '../components/layout'
import { EmptyState, ErrorState, Segmented, SkeletonRows, StatusBadge } from '../components/ui'
import { Link } from '../lib/router'
import { REQ_STATUS } from '../lib/status'
import './overview.css'

type View = 'pending' | 'done'
type Scope = 'all' | 'mine'

const ME_KEY = 'taktflow.attention.me'
const SCOPE_KEY = 'taktflow.attention.scope'

function readPref(key: string): string | undefined {
  try {
    return window.localStorage.getItem(key) ?? undefined
  } catch {
    return undefined
  }
}
function writePref(key: string, value: string) {
  try {
    window.localStorage.setItem(key, value)
  } catch {
    /* 隐私模式等：只是记不住选择 */
  }
}

/** 是否派给某人：assignees 里有他；没有 assignees 但 owner 职责在他的 duties 里也算。 */
function assignedTo(a: AttentionItem, me: SpaceMember | undefined): boolean {
  if (!me) return false
  if (a.assignees?.length) return a.assignees.includes(me.id)
  return Boolean(a.owner && me.duties?.includes(a.owner))
}

export function AttentionPage() {
  const [view, setView] = useState<View>('pending')
  const [scope, setScopeState] = useState<Scope>(() => (readPref(SCOPE_KEY) === 'mine' ? 'mine' : 'all'))
  const [meId, setMeState] = useState<string | undefined>(() => readPref(ME_KEY))
  const q = useAsync(async (ds) => {
    const [items, reqs, members] = await Promise.all([ds.attention(), ds.requirements(), ds.space().then((s) => s.members).catch(() => [] as SpaceMember[])])
    return { items, reqs, members }
  }, [])
  useCrumbs([{ label: '待办' }], [])
  if (q.error && !q.data) return <ErrorState error={q.error} onRetry={q.reload} />

  const setScope = (s: Scope) => (setScopeState(s), writePref(SCOPE_KEY, s))
  const setMe = (id: string) => (setMeState(id), writePref(ME_KEY, id))
  const members = q.data?.members ?? []
  // 还没有登录身份（协议没有"当前用户"）：让人自己选"我是谁"，默认空间 owner
  const me = members.find((m) => m.id === meId) ?? members.find((m) => m.role === 'owner') ?? members[0]
  const all = q.data?.items ?? []
  const inScope = (a: AttentionItem) => scope === 'all' || assignedTo(a, me)
  const items = all.filter((a) => (view === 'pending' ? !a.answeredAt : a.answeredAt) && inScope(a))
  const pendingCount = all.filter((a) => !a.answeredAt && inScope(a)).length
  const mineCount = all.filter((a) => !a.answeredAt && assignedTo(a, me)).length
  const staleCount = items.filter((a) => a.stale).length
  const groups = q.data ? q.data.reqs.map((r) => ({ r, items: items.filter((a) => a.requirementId === r.id) })).filter((g) => g.items.length) : []

  return (
    <div className="page attention-page fade-in">
      <PageHeader
        title="待办"
        sub="所有等人处理的事项：审批、回答澄清问题、门禁裁决、判决交人、重复失败与预算。处理结果写入审计日志，运行随后自动继续。"
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
      <div className="att-filter">
        <Segmented<Scope>
          value={scope}
          onChange={setScope}
          options={[
            { value: 'all', label: '全部' },
            { value: 'mine', label: `派给我 ${mineCount}` },
          ]}
        />
        {members.length > 0 && (
          <label className="att-me">
            <UserRound />
            <span className="faint">我是</span>
            <select className="select select-sm" value={me?.id} onChange={(e) => setMe(e.target.value)} aria-label="选择我的身份">
              {members.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                  {m.duties?.length ? `（${m.duties.join(' / ')}）` : ''}
                </option>
              ))}
            </select>
          </label>
        )}
        <span style={{ flex: 1 }} />
        {staleCount > 0 && (
          <span className="att-stale-chip" title="审批对象之后有新版本">
            <History />
            {staleCount} 项审批对象已更新
          </span>
        )}
      </div>
      {!q.data ? (
        <div className="card">
          <SkeletonRows rows={4} gap={30} />
        </div>
      ) : groups.length === 0 ? (
        <div className="card">
          <EmptyState
            icon={Inbox}
            title={scope === 'mine' ? (view === 'pending' ? `没有派给 ${me?.name ?? '你'} 的待办` : `${me?.name ?? '你'} 名下还没有处理过的事项`) : view === 'pending' ? '全部处理完了' : '还没有处理过的事项'}
            hint={scope === 'mine' ? '按节点职责派发：节点的负责职责与空间成员的职责标签匹配时派给此人。' : view === 'pending' ? '新的审批和问题会出现在这里，也会在左侧导航显示数量。' : undefined}
            action={scope === 'mine' ? <button className="btn btn-sm" onClick={() => setScope('all')}>看全部待办</button> : undefined}
          />
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
