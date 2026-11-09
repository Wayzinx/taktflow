import { MessageSquarePlus } from 'lucide-react'
import type { StewardFeedItem } from '@taktflow/core'
import { useAsync } from '../../api'
import { focusAnchor } from '../../components/steward/jump'
import { navigate, setQuery, useLocation } from '../../lib/router'
import { StewardSidebar } from '../steward/sidebar'
import '../steward/steward-page.css'

/**
 * Solo 模式的左栏（docs/design/29）：新对话 + 会话 / 动态。选中状态全在地址里（?thread= / ?side=feed），
 * Solo 页按地址变化重置焦点与草稿，这里不需要和页面共享状态。
 */
export default function SoloRail({ collapsed }: { collapsed: boolean }) {
  const { query } = useLocation()
  const threadId = query.get('thread') ?? undefined
  const side = query.get('side') === 'feed' ? 'feed' : 'threads'
  // 会话号变了（新建、切换）就重拉一次列表，新会话立刻出现在最上面
  const threads = useAsync((ds) => ds.stewardThreads(), [threadId])
  const pick = (id: string | undefined) => setQuery({ thread: id, focus: undefined }, { replace: false })
  const fresh = () => navigate('/solo')
  const onFeed = (it: StewardFeedItem) => {
    if (it.type === 'proposal') return pick(it.proposal.threadId)
    if (it.type === 'delegation') return pick(it.threadId)
    pick(undefined)
    focusAnchor([it.type === 'risk' ? it.risk.key : 'digest'], 60)
  }
  return (
    <div className="sb-solo">
      <button type="button" className="sb-new" onClick={fresh} title={collapsed ? '新对话' : undefined} aria-label="新对话">
        <MessageSquarePlus aria-hidden />
        <span className="sb-label">新对话</span>
      </button>
      {!collapsed && <StewardSidebar view={side} onView={(v) => setQuery({ side: v === 'feed' ? 'feed' : undefined })} threads={threads} current={threadId} onPick={pick} onFeed={onFeed} />}
    </div>
  )
}
