import { useEffect, useRef } from 'react'
import { FolderOpen, LockKeyhole, MessagesSquare, MessageSquarePlus } from 'lucide-react'
import type { StewardFeedItem } from '@taktflow/core'
import { invalidate, useAsync } from '../../api'
import { focusAnchor } from '../../components/steward/jump'
import { personalSteward } from '../../lib/space'
import { SpaceSwitcher } from '../../components/space-switcher'
import { Link, navigate, setQuery, useLocation } from '../../lib/router'
import { StewardSidebar } from '../steward/sidebar'
import '../steward/steward-page.css'

/**
 * Solo 模式的左栏（docs/design/29）：新对话 + 会话 / 动态。选中状态全在地址里（?thread= / ?side=feed），
 * Solo 页按地址变化重置焦点与草稿，这里不需要和页面共享状态。
 */
export default function SoloRail({ collapsed }: { collapsed: boolean }) {
  const { query, spaceId } = useLocation()
  const shared = !personalSteward(location.pathname)
  const project = useAsync(ds => shared ? ds.project() : Promise.resolve(undefined), [spaceId, shared])
  const threadId = query.get('thread') ?? undefined
  const side = query.get('side') === 'feed' ? 'feed' : 'threads'
  // 会话号变了（新建、切换）就重拉一次列表，新会话立刻出现在最上面
  const threads = useAsync((ds) => ds.stewardThreads(), [threadId])
  // 有会话在回复时隔几秒刷新一次，状态徽标（回复中 → 完成 / 出错）跟得上
  const replying = shared || threads.data?.some((t) => t.status === 'replying')
  const reload = useRef(threads.reload)
  reload.current = threads.reload
  useEffect(() => {
    if (!replying) return
    const t = setInterval(() => { if (!document.hidden) reload.current() }, 6000)
    return () => clearInterval(t)
  }, [replying])
  const changed = (deletedId?: string) => {
    if (deletedId && deletedId === threadId) navigate('/solo')
    // 重命名 / 置顶 / 归档之后，Solo 页头读的会话也要跟着刷新，不只是这一栏
    invalidate()
  }
  const pick = (id: string | undefined) => setQuery({ thread: id, room: undefined, focus: undefined }, { replace: false })
  const fresh = () => navigate('/solo')
  const onFeed = (it: StewardFeedItem) => {
    if (it.type === 'proposal') return pick(it.proposal.threadId)
    if (it.type === 'delegation') return pick(it.threadId)
    pick(undefined)
    focusAnchor([it.type === 'risk' ? it.risk.key : 'digest'], 60)
  }
  return (
    <div className="sb-solo">
      {shared && !collapsed && <SpaceSwitcher fallbackName={project.data?.name} />}
      <button type="button" className="sb-new" onClick={fresh} title={collapsed ? '新对话' : undefined} aria-label="新对话">
        <MessageSquarePlus aria-hidden />
        <span className="sb-label">新对话</span>
      </button>
      {shared && <Link to="/steward?room=team" className={`sb-item${query.get('room') === 'team' ? ' active' : ''}`} title="空间讨论与开发任务">
        <MessagesSquare aria-hidden /><span className="sb-label">空间讨论与开发</span>
      </Link>}
      {!collapsed && <StewardSidebar view={side} onView={(v) => setQuery({ side: v === 'feed' ? 'feed' : undefined })} threads={threads} current={threadId} onPick={pick} onFeed={onFeed} onChanged={changed} />}
      {shared && !collapsed && !!project.data?.requirements.length && <div className="sb-section">
        <div className="sb-section-title">需求与 Agent 会话</div>
        {project.data.requirements.map(req => <Link key={req.id} className="sb-req" to={`/req/${encodeURIComponent(req.id)}?tab=chat`} title={`${req.id} · ${req.title}`}>
          <FolderOpen aria-hidden size={14} /><span className="truncate">{req.title}</span>
        </Link>)}
      </div>}
      {shared && <Link to="/personal" className="sb-item" title="个人管家 · 仅自己可见">
        <LockKeyhole aria-hidden /><span className="sb-label">个人管家</span>
      </Link>}
    </div>
  )
}
