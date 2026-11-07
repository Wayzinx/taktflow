import { useCallback, useEffect, useState } from 'react'
import { Activity, ArrowLeft, MessageSquarePlus, Settings2 } from 'lucide-react'
import type { StewardContextRef, StewardFeedItem, StewardThread } from '@taktflow/core'
import { useAsync } from '../../api'
import { useCrumbs } from '../../components/layout'
import { focusAnchor } from '../../components/steward/jump'
import { ThreadView } from '../../components/steward/thread-view'
import { PageHeader, useStewardSuggestions } from '../../components/ui'
import { fmtRelative } from '../../lib/format'
import { setQuery, useLocation } from '../../lib/router'
import { HealthDrawer } from './health-drawer'
import { StewardHome } from './home'
import { SettingsDrawer } from './settings-drawer'
import { StewardSidebar, type SideView } from './sidebar'
import '../../components/steward/steward.css'
import './steward-page.css'

/**
 * 管家整页 /steward（全局；按需加载）：左栏会话 / 动态，右栏对话；没选会话时右栏是"今天"（汇报 + 风险 + 可以直接问的）。
 * ?thread=<id> 选中会话；?focus=digest 定位到汇报；?side=feed 左栏看动态；?drawer=health | settings 打开产品健康 / 管家设置抽屉。
 */
export function StewardPage() {
  const { query } = useLocation()
  const threadId = query.get('thread') ?? undefined
  const drawer = query.get('drawer') ?? undefined
  const side: SideView = query.get('side') === 'feed' ? 'feed' : 'threads'
  const threads = useAsync((ds) => ds.stewardThreads(), [])
  const suggestions = useStewardSuggestions('steward')
  const [draft, setDraft] = useState('')
  const [ctx, setCtx] = useState<StewardContextRef[]>([])
  useCrumbs([{ label: '管家' }], [])
  // ?focus=digest | <风险 key>：从总览"自上次以来"等入口进来时，定位到"今天"里的那张卡
  const focus = query.get('focus')
  useEffect(() => {
    if (focus && !threadId) focusAnchor([focus], 120)
  }, [focus, threadId])

  const pick = (id: string | undefined) => setQuery({ thread: id }, { replace: false })
  const onCreated = useCallback(
    (t: StewardThread) => {
      setQuery({ thread: t.id })
      threads.reload()
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  )
  const current = threads.data?.find((t) => t.id === threadId)
  // 页头建议在本页不开停靠面板：直接开新会话并预填
  const onHeaderChip = (text: string) => {
    pick(undefined)
    setCtx([])
    setDraft(text)
  }
  const fresh = () => {
    pick(undefined)
    setDraft('')
    setCtx([])
  }
  const onFeed = (it: StewardFeedItem) => {
    if (it.type === 'proposal') return pick(it.proposal.threadId)
    if (it.type === 'delegation') return pick(it.threadId)
    pick(undefined)
    // 回到"今天"，定位到那条风险 / 汇报
    focusAnchor([it.type === 'risk' ? it.risk.key : 'digest'], 60)
  }

  return (
    <div className="page stwp">
      <PageHeader
        title="管家"
        description="跨空间回答问题、主动汇报进度与风险、替你配置和操作；写操作都先给你确认。"
        suggestions={suggestions}
        onSuggestion={onHeaderChip}
        actions={
          <>
            <button type="button" className="btn" onClick={() => setQuery({ drawer: 'health' })}>
              <Activity />
              产品健康
            </button>
            <button type="button" className="btn btn-icon" title="管家设置" aria-label="管家设置" onClick={() => setQuery({ drawer: 'settings' })}>
              <Settings2 />
            </button>
            <button type="button" className="btn btn-primary" onClick={fresh} title="新会话">
              <MessageSquarePlus />
              新会话
            </button>
          </>
        }
      />
      <div className="stwp-grid" data-thread={threadId ? 'open' : undefined}>
        <StewardSidebar view={side} onView={(v) => setQuery({ side: v === 'feed' ? 'feed' : undefined })} threads={threads} current={threadId} onPick={pick} onFeed={onFeed} />
        <section className="stwp-main card" aria-label={threadId ? '对话' : '今天'}>
          {threadId && (
            <header className="stwp-main-head">
              <button type="button" className="btn btn-ghost btn-icon btn-sm" title="回到今天" aria-label="回到今天" onClick={() => pick(undefined)}>
                <ArrowLeft />
              </button>
              <h2 className="stwp-main-title truncate">{current?.title ?? '会话'}</h2>
              {(current?.context ?? []).slice(0, 2).map((c) => (
                <span key={`${c.type}:${c.id}`} className="stw-tag">
                  {c.label ?? c.id}
                </span>
              ))}
              {current && <span className="faint num stwp-main-time">更新于 {fmtRelative(current.updatedAt)}</span>}
            </header>
          )}
          <ThreadView
            className="stwp-thread"
            threadId={threadId}
            onThreadCreated={onCreated}
            draft={draft}
            onDraft={setDraft}
            context={ctx}
            onContext={setCtx}
            autoFocus={!!threadId}
            empty={(ask) => (
              <StewardHome
                suggestions={suggestions}
                ask={(text, c) => {
                  // 首页里点的问题 / 建议动作：开新会话直接发出，上下文换成那条风险的
                  if (c) setCtx(c)
                  ask(text, c)
                }}
              />
            )}
          />
        </section>
      </div>
      <HealthDrawer open={drawer === 'health'} onClose={() => setQuery({ drawer: undefined })} />
      <SettingsDrawer open={drawer === 'settings'} onClose={() => setQuery({ drawer: undefined })} />
    </div>
  )
}
