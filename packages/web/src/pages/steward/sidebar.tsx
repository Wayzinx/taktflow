import { useEffect, useState } from 'react'
import { CircleCheck, FileText, Forward, MessagesSquare, OctagonAlert, TriangleAlert, Undo2, type LucideIcon } from 'lucide-react'
import type { DelegationStatus, StewardFeedItem, StewardThread } from '@taktflow/core'
import { useAsync, useSource, type AsyncState } from '../../api'
import { normReceipt } from '../../components/receipt'
import { EmptyState, ErrorState, Segmented, SkeletonRows, TabPanel, useFlashRows, useStagger } from '../../components/ui'
import { fmtRelative } from '../../lib/format'
import { useStewardUnread } from '../../lib/ui-store'
import { BeeGlyph } from '../../components/identity'
import { ThreadList } from './thread-list'

export type SideView = 'threads' | 'feed'

const DELEGATION_TITLE: Record<DelegationStatus, string> = {
  sent: '收到转达',
  taken: '接手了转达',
  started: '按转达开始干活',
  done: '处理完了转达',
  replied: '回复了',
  refused: '拒绝了转达',
  expired: '没接手转达（已过期）',
  uncertain: '可能没收到转达',
}

function feedLine(it: StewardFeedItem): { icon: LucideIcon; tone?: string; title: string; sub?: string } | null {
  switch (it.type) {
    case 'digest':
      return { icon: FileText, title: '汇报', sub: it.digest.summary }
    case 'risk':
      return { icon: it.risk.level === 'high' ? OctagonAlert : TriangleAlert, tone: it.change === 'resolved' ? 'success' : it.risk.level === 'high' ? 'failed' : 'waiting', title: `${{ new: '新风险', escalated: '风险升级', resolved: '风险解除' }[it.change]}：${it.risk.title}`, sub: it.risk.detail }
    case 'proposal': {
      const p = it.proposal
      const verb = { pending: '待你决定', applied: p.auto ? '已自动执行' : '已执行', rejected: '已拒绝', failed: '执行失败', reverted: '已撤销', stale: '已过期' }[p.status]
      return { icon: p.status === 'applied' ? CircleCheck : p.status === 'reverted' ? Undo2 : BeeGlyph, tone: p.status === 'applied' ? 'success' : p.status === 'pending' ? 'waiting' : undefined, title: `提案${verb}：${p.title}` }
    }
    case 'delegation':
      return { icon: Forward, title: `${it.delegation.requirementId} 的 Lead ${DELEGATION_TITLE[normReceipt(it.delegation.status)]}`, sub: it.delegation.reply }
    default:
      return null
  }
}

const feedId = (it: StewardFeedItem) =>
  it.type === 'digest' ? it.digest.id : it.type === 'risk' ? `${it.risk.key}:${it.change}` : it.type === 'proposal' ? `${it.proposal.id}:${it.proposal.status}` : it.type === 'delegation' ? it.delegation.messageId : String(it.count)

function FeedList({ onOpen }: { onOpen: (it: StewardFeedItem) => void }) {
  const ds = useSource()
  const q = useAsync((d) => d.stewardFeed(), [])
  const [live, setLive] = useState<StewardFeedItem[]>([])
  useEffect(() => ds.subscribeStewardFeed((it) => it.type !== 'unread' && setLive((cur) => [it, ...cur])), [ds])
  const items = [...live, ...(q.data ?? [])].filter((it) => it.type !== 'unread')
  const keyOf = (it: StewardFeedItem) => `${it.type}-${it.at}-${feedId(it)}`
  const st = useStagger(q.data ? items.length : 0)
  const flash = useFlashRows(items.map((it) => keyOf(it)))
  if (q.error && !q.data) return <ErrorState compact error={q.error} onRetry={q.reload} />
  if (!q.data) return <SkeletonRows rows={5} />
  if (!items.length) return <EmptyState compact icon={FileText} title="还没有动态" body="汇报、风险变化和提案结果会出现在这里" />
  return (
    <ul className="stwp-list" aria-label="动态">
      {items.map((it, i) => {
        const l = feedLine(it)
        if (!l) return null
        const Icon = l.icon
        const s = st(i)
        return (
          <li key={keyOf(it)} className={`${s.className ?? ''} ${flash(keyOf(it))}`} style={s.style}>
            <button type="button" className="stwp-item stwp-feed pressable" onClick={() => onOpen(it)}>
              <Icon className="stwp-feed-icon" data-tone={l.tone} aria-hidden />
              <span className="stwp-feed-main">
                <span className="stwp-item-top">
                  <span className="stwp-item-title stwp-clamp">{l.title}</span>
                </span>
                {l.sub && <span className="stwp-item-last stwp-clamp">{l.sub}</span>}
                <span className="faint num">{fmtRelative(it.at)}</span>
              </span>
            </button>
          </li>
        )
      })}
    </ul>
  )
}

/** 管家页左栏：会话（可搜索）/ 动态（汇报、风险变化、提案结果、Lead 回复；实时追加并闪一下）。 */
export function StewardSidebar({ view, onView, threads, current, onPick, onFeed, onChanged }: { view: SideView; onView: (v: SideView) => void; threads: AsyncState<StewardThread[]>; current?: string; onPick: (id: string) => void; onFeed: (it: StewardFeedItem) => void; onChanged: (deletedId?: string) => void }) {
  const unread = useStewardUnread()
  return (
    <aside className="stwp-side card" aria-label="会话与动态">
      <div className="stwp-side-head">
        <Segmented
          value={view}
          onChange={onView}
          size="sm"
          ariaLabel="左栏"
          options={[
            { value: 'threads', label: '会话', icon: MessagesSquare, count: threads.data?.length },
            { value: 'feed', label: '动态', icon: FileText, count: unread || undefined },
          ]}
        />
      </div>
      <TabPanel key={view} className="stwp-side-body">
        {view === 'feed' ? (
          <FeedList onOpen={onFeed} />
        ) : threads.error && !threads.data ? (
          <ErrorState compact error={threads.error} onRetry={threads.reload} />
        ) : !threads.data ? (
          <SkeletonRows rows={5} />
        ) : (
          <ThreadList threads={threads.data} current={current} onPick={onPick} onChanged={onChanged} />
        )}
      </TabPanel>
    </aside>
  )
}
