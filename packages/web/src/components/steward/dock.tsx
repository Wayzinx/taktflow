import { useEffect, useRef, useState } from 'react'
import { Bot, CornerDownRight, History, Maximize2, MessageSquarePlus, MessagesSquare } from 'lucide-react'
import type { StewardContextRef } from '@taktflow/core'
import { useAsync } from '../../api'
import { Drawer, Menu, useStewardSuggestions, withShortcut } from '../ui'
import { fmtRelative } from '../../lib/format'
import { navigate, useLocation } from '../../lib/router'
import { closeSteward, useStewardDock } from '../../lib/ui-store'
import { pageKeyOf, usePageStewardContext } from './context'
import { ThreadView } from './thread-view'
import './steward.css'

const keyOf = (c: StewardContextRef) => `${c.type}:${c.id}`

/** 停靠面板的空状态：本页建议（点了直接问）+ 最近的会话。 */
function DockWelcome({ onAsk, onResume }: { onAsk: (t: string) => void; onResume: (id: string) => void }) {
  const { path } = useLocation()
  const page = pageKeyOf(path)
  const suggestions = useStewardSuggestions(page.page, page.id)
  const threads = useAsync((ds) => ds.stewardThreads(), [])
  return (
    <div className="stw-welcome">
      <div className="stw-welcome-head">
        <span className="stw-welcome-icon" aria-hidden>
          <Bot />
        </span>
        <div>
          <h3 className="stw-welcome-title">想让我做点什么？</h3>
          <p className="stw-welcome-body">我会带上这一页的上下文。查询直接回答，改动先给你一份提案确认。</p>
        </div>
      </div>
      {suggestions.length > 0 && (
        <div className="stw-welcome-sec">
          <div className="section-label">这一页可以问</div>
          <div className="stw-welcome-list">
            {suggestions.map((s) => (
              <button key={s} type="button" className="stw-welcome-item pressable" onClick={() => onAsk(s)}>
                <CornerDownRight aria-hidden />
                <span>{s}</span>
              </button>
            ))}
          </div>
        </div>
      )}
      {(threads.data ?? []).length > 0 && (
        <div className="stw-welcome-sec">
          <div className="section-label">接着聊</div>
          <div className="stw-welcome-list">
            {threads.data!.slice(0, 3).map((t) => (
              <button key={t.id} type="button" className="stw-welcome-item pressable" onClick={() => onResume(t.id)}>
                <MessagesSquare aria-hidden />
                <span className="truncate">{t.title}</span>
                <span className="faint num">{fmtRelative(t.updatedAt)}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

/**
 * 管家停靠面板：任意页 ⌘J / 侧栏管家按钮 / 页头建议打开，从右侧滑入（Drawer mode="dock"）。
 * 打开规则：带 threadId → 打开那个会话；带预填问题 → 新会话 + 预填；否则回到上次的会话。
 * 上下文 = 当前页推导 + 调用方额外带的，以标签显示在输入框上方，可删。
 */
export function StewardDock() {
  const dock = useStewardDock()
  const pageCtx = usePageStewardContext()
  const [ctx, setCtx] = useState(pageCtx)
  const [draft, setDraft] = useState('')
  const [threadId, setThreadId] = useState<string>()
  const [history, setHistory] = useState(false)
  const historyBtn = useRef<HTMLButtonElement>(null)
  const threads = useAsync((ds) => (history ? ds.stewardThreads() : Promise.resolve([])), [history])
  const pageKey = pageCtx.map(keyOf).join('|')

  useEffect(() => {
    if (!dock.open) return
    const extra = (dock.context ?? []).filter((c) => !pageCtx.some((p) => keyOf(p) === keyOf(c)))
    setCtx([...pageCtx, ...extra])
    if (dock.threadId) setThreadId(dock.threadId)
    else if (dock.prefill) setThreadId(undefined)
    if (dock.prefill) setDraft(dock.prefill)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dock.open, dock.nonce])
  // 面板开着时换页：上下文跟着换（保留调用方额外带的）
  useEffect(() => {
    if (!dock.open) return
    setCtx((cur) => [...pageCtx, ...cur.filter((c) => (dock.context ?? []).some((x) => keyOf(x) === keyOf(c)) && !pageCtx.some((p) => keyOf(p) === keyOf(c)))])
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageKey])

  const fresh = () => {
    setThreadId(undefined)
    setDraft('')
  }

  return (
    <Drawer
      mode="dock"
      open={dock.open}
      onClose={closeSteward}
      width={440}
      className="stw-dock"
      title="管家"
      description="查询直接回答；改动先出提案，你批准后才执行"
      headerActions={
        <>
          <button type="button" className="btn btn-ghost btn-icon btn-sm" title="新会话" aria-label="新会话" onClick={fresh}>
            <MessageSquarePlus />
          </button>
          <button ref={historyBtn} type="button" className="btn btn-ghost btn-icon btn-sm" title="历史会话" aria-label="历史会话" aria-haspopup="menu" onClick={() => setHistory(true)}>
            <History />
          </button>
          <button type="button" className="btn btn-ghost btn-icon btn-sm" title={withShortcut('在整页打开', 'mod+j')} aria-label="在整页打开" onClick={() => navigate(`/steward${threadId ? `?thread=${threadId}` : ''}`)}>
            <Maximize2 />
          </button>
          <Menu
            open={history && !!threads.data}
            onClose={() => setHistory(false)}
            anchor={historyBtn}
            placement="bottom-end"
            minWidth={280}
            ariaLabel="历史会话"
            items={(threads.data ?? []).slice(0, 8).map((t, i) => ({ id: t.id, label: t.title, icon: MessagesSquare, hint: fmtRelative(t.updatedAt), section: i === 0 ? '最近的会话' : undefined, checked: t.id === threadId, onSelect: () => setThreadId(t.id) }))}
          />
        </>
      }
    >
      <ThreadView
        className="stw-thread-dock"
        threadId={threadId}
        onThreadCreated={(t) => setThreadId(t.id)}
        draft={draft}
        onDraft={setDraft}
        context={ctx}
        onContext={setCtx}
        autoFocus={dock.open}
        empty={(ask) => <DockWelcome onAsk={ask} onResume={setThreadId} />}
      />
    </Drawer>
  )
}
