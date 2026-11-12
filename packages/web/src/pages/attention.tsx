import { useState } from 'react'
import { History, Inbox, UserRound } from 'lucide-react'
import type { AttentionItem, SpaceMember } from '@taktflow/core'
import { useAsync } from '../api'
import { AttentionCard } from '../components/attention-card'
import { useCrumbs } from '../components/layout'
import { EmptyState, ErrorState, PageHeader, Segmented, Skeleton, SkeletonRows, StatusBadge, useFlashRows, useStagger, useStewardSuggestions } from '../components/ui'
import { Link } from '../lib/router'
import { actingUser, setActingUser } from '../lib/acting-user'
import { REQ_STATUS } from '../lib/status'
import { assignedTo } from './attention-assign'
import './overview.css'

type View = 'pending' | 'done'
type Scope = 'all' | 'mine'

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

export function AttentionPage() {
  const [view, setView] = useState<View>('pending')
  const [scope, setScopeState] = useState<Scope>(() => (readPref(SCOPE_KEY) === 'mine' ? 'mine' : 'all'))
  const [meId, setMeState] = useState<string | undefined>(() => actingUser())
  const q = useAsync(async (ds) => {
    const [items, reqs, members, viewer] = await Promise.all([
      ds.attention(),
      ds.requirements(),
      ds.space().then((s) => s.members).catch(() => [] as SpaceMember[]),
      ds.me().catch(() => undefined),
    ])
    return { items, reqs, members, viewer }
  }, [])
  useCrumbs([{ label: '待办' }], [])
  const suggestions = useStewardSuggestions('attention')
  const allIds = (q.data?.items ?? []).map((a) => a.requestId)
  const flash = useFlashRows(allIds)
  const groupCount = q.data ? new Set((q.data.items ?? []).map((a) => a.requirementId)).size : 0
  const st = useStagger(groupCount)
  if (q.error && !q.data) return <ErrorState error={q.error} onRetry={q.reload} />

  const setScope = (s: Scope) => (setScopeState(s), writePref(SCOPE_KEY, s))
  // 选择的身份同时作为请求头 x-takt-user 发给服务端：筛选"派给我"与审批 / 处置的审计记录是同一个人
  const setMe = (id: string) => (setMeState(id), setActingUser(id))
  const members = q.data?.members ?? []
  // 默认身份取 GET /me（服务端在没有 x-takt-user 时用空间第一个 owner）；人可以改选"我是谁"
  const me = members.find((m) => m.id === meId) ?? members.find((m) => m.id === q.data?.viewer?.id) ?? q.data?.viewer?.member ?? members[0]
  const all = q.data?.items ?? []
  const reqs = q.data?.reqs ?? []
  const mine = (a: AttentionItem) => assignedTo(a, me, members, reqs)
  const inScope = (a: AttentionItem) => scope === 'all' || mine(a)
  const items = all.filter((a) => (view === 'pending' ? !a.answeredAt : a.answeredAt) && inScope(a))
  const pendingCount = all.filter((a) => !a.answeredAt && inScope(a)).length
  const mineCount = all.filter((a) => !a.answeredAt && mine(a)).length
  const staleCount = items.filter((a) => a.stale).length
  const groups = q.data ? q.data.reqs.map((r) => ({ r, items: items.filter((a) => a.requirementId === r.id) })).filter((g) => g.items.length) : []

  return (
    <div className="page attention-page">
      <PageHeader
        title="待办"
        description={
          !q.data ? (
            <Skeleton w={280} h={12} style={{ marginTop: 6 }} />
          ) : pendingCount ? (
            `${pendingCount} 项等人处理${staleCount ? `，其中 ${staleCount} 项审批对象已更新` : ''}。处理完运行会自动继续。`
          ) : (
            '审批、澄清问题、门禁裁决都在这里；现在没有等你的事。'
          )
        }
        suggestions={suggestions}
        actions={
          <Segmented<View>
            value={view}
            onChange={setView}
            options={[
              { value: 'pending', label: '待处理', count: pendingCount },
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
            { value: 'mine', label: '派给我', count: mineCount },
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
            body={scope === 'mine' ? '按节点职责派发：节点的负责职责与你的职责标签匹配时派给你；没有成员承担这项职责时派给需求负责人。' : view === 'pending' ? '新的审批和问题会出现在这里，左侧导航也会显示数量。' : '处理过的审批和回答会留在这里备查。'}
            action={scope === 'mine' ? <button className="btn btn-sm" onClick={() => setScope('all')}>看全部待办</button> : view === 'done' ? <button className="btn btn-sm" onClick={() => setView('pending')}>回到待处理</button> : undefined}
            stewardAsk={view === 'pending' ? '最近有哪些需求可能需要我拍板？' : undefined}
          />
        </div>
      ) : (
        <div className="att-groups">
          {groups.map(({ r, items }, i) => (
            <section key={r.id} className={`card ${st(i).className ?? ''}`} style={st(i).style}>
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
                <div key={a.requestId} className={flash(a.requestId)}>
                  <AttentionCard item={a} />
                </div>
              ))}
            </section>
          ))}
        </div>
      )}
    </div>
  )
}
