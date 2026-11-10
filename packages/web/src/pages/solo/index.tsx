import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Activity, Settings2 } from 'lucide-react'
import type { StewardContextRef, StewardThread } from '@taktflow/core'
import { useAsync } from '../../api'
import { useCrumbs } from '../../components/layout'
import { decodeFocus, encodeFocus, EntityFocusContext, sameFocus, type EntityFocusApi, type FocusTarget } from '../../components/steward/focus'
import { focusAnchor } from '../../components/steward/jump'
import { ThreadView } from '../../components/steward/thread-view'
import { fmtRelative } from '../../lib/format'
import { setQuery, useLocation } from '../../lib/router'
import { closeSteward, useStewardDock } from '../../lib/ui-store'
import { HealthDrawer } from '../steward/health-drawer'
import { SettingsDrawer } from '../steward/settings-drawer'
import { FocusPanel } from './focus-panel'
import { SoloHero, SoloHome } from './home'
import '../../components/steward/steward.css'
import '../steward/steward-page.css'
import './entity/entity.css'
import './solo.css'

/**
 * Solo（docs/design/28）：和管家直接对话，需求、运行、节点在会话里实时画出来，右侧焦点面板展开完整视图。取代原来的 /steward 整页。
 * ?thread=<id> 选中会话；?focus=requirement:<space>/<id> | run:<space>/<runId>[/<nodeId>] | space:<id> 焦点面板（刷新、分享后回到同一视图）；
 * ?focus=digest | <风险 key> 定位到首页"今天"里那张卡；?side=feed 左栏看动态；?drawer=health | settings 打开抽屉。
 * 会话列表在 App 侧栏的 Solo 模式里（pages/solo/rail.tsx，docs/design/29），这里只有对话和焦点面板。
 */
export function SoloPage() {
  const { query } = useLocation()
  const threadId = query.get('thread') ?? undefined
  const drawer = query.get('drawer') ?? (query.get('settings') ? 'settings' : undefined)
  const rawFocus = query.get('focus')
  const focus = decodeFocus(rawFocus)
  const threads = useAsync((ds) => ds.stewardThreads(), [threadId])
  const [draft, setDraft] = useState('')
  const [ctx, setCtx] = useState<StewardContextRef[]>([])
  // 地址里带了焦点（分享 / 刷新）就先固定，不被会话里的旧对象带走
  const [follow, setFollow] = useState(!focus)
  const followRef = useRef(follow)
  followRef.current = follow
  useCrumbs([{ label: '管家' }], [])

  useEffect(() => {
    if (rawFocus && !focus && !threadId) focusAnchor([rawFocus], 120)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rawFocus, threadId])

  const show = (t: FocusTarget | undefined) => setQuery({ focus: t ? encodeFocus(t) : undefined })
  const focusKey = focus ? encodeFocus(focus) : ''
  const api = useMemo<EntityFocusApi>(
    () => ({
      offer: (t) => {
        if (followRef.current && !sameFocus(t, decodeFocus(new URLSearchParams(location.search).get('focus')))) show(t)
      },
      open: (t) => {
        setFollow(false)
        show(t)
      },
      current: focus,
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [focusKey],
  )

  // 换会话（侧栏点了别的会话或"新对话"）：恢复跟随，由新会话里的对象重新决定焦点；回到首页时清空草稿和上下文
  const lastThread = useRef(threadId)
  const pendingAsk = useRef<{ draft: string; context?: StewardContextRef[] } | undefined>(undefined)
  useEffect(() => {
    if (lastThread.current === threadId) return
    lastThread.current = threadId
    setFollow(true)
    if (!threadId) {
      setDraft(pendingAsk.current?.draft ?? '')
      setCtx(pendingAsk.current?.context ?? [])
      pendingAsk.current = undefined
    }
  }, [threadId])

  // 这一页本身就是和管家的对话，不再叠停靠面板：进来时面板若还开着就收起；之后的"问管家"（⌘J、带问题的入口）落到本页
  const dock = useStewardDock()
  const seenAsk = useRef(dock.nonce)
  useEffect(() => {
    if (!dock.open) return
    const fresh = dock.nonce !== seenAsk.current
    seenAsk.current = dock.nonce
    closeSteward()
    if (!fresh) return
    if (dock.threadId) setQuery({ thread: dock.threadId })
    else if (dock.prefill && threadId) {
      // 带着新问题：开新对话（和停靠面板一致），草稿等回到首页后再填
      pendingAsk.current = { draft: dock.prefill, context: dock.context }
      setQuery({ thread: undefined, focus: undefined })
    } else if (dock.prefill) {
      setDraft(dock.prefill)
      if (dock.context) setCtx(dock.context)
    }
    requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>('.solo-main textarea')?.focus())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dock.open, dock.nonce])
  const onCreated = useCallback((t: StewardThread) => setQuery({ thread: t.id }), [])
  const current = threads.data?.find((t) => t.id === threadId)

  return (
    <EntityFocusContext.Provider value={api}>
      <div className="solo" data-panel={focus ? 'open' : undefined}>
        <section className="solo-main" aria-label={threadId ? '对话' : '管家首页'}>
          <header className="solo-head">
            {threadId && <h2 className="solo-head-title truncate">{current?.title ?? '会话'}</h2>}
            {current && <span className="faint num">更新于 {fmtRelative(current.updatedAt)}</span>}
            <span className="solo-head-gap" />
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setQuery({ drawer: 'health' })}>
              <Activity />
              产品健康
            </button>
            <button type="button" className="btn btn-ghost btn-icon btn-sm" title="管家设置" aria-label="管家设置" onClick={() => setQuery({ drawer: 'settings' })}>
              <Settings2 />
            </button>
          </header>
          <ThreadView
            className="solo-thread"
            threadId={threadId}
            onThreadCreated={onCreated}
            draft={draft}
            onDraft={setDraft}
            context={ctx}
            onContext={setCtx}
            autoFocus
            globalMentions
            placeholder="问管家，或 @ 一个需求、运行、节点"
            hero={<SoloHero />}
            empty={(ask) => (
              <SoloHome
                ask={(text, c) => {
                  if (c) setCtx(c)
                  ask(text, c)
                }}
              />
            )}
          />
        </section>
        {focus && (
          <FocusPanel
            target={focus}
            follow={follow}
            onFollow={setFollow}
            onTarget={(t) => {
              setFollow(false)
              show(t)
            }}
            onClose={() => {
              setFollow(false)
              show(undefined)
            }}
          />
        )}
      </div>
      <HealthDrawer open={drawer === 'health'} onClose={() => setQuery({ drawer: undefined })} />
      <SettingsDrawer open={drawer === 'settings'} onClose={() => setQuery({ drawer: undefined, settings: undefined })} />
    </EntityFocusContext.Provider>
  )
}
