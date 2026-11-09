import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { History, Maximize2, MessageSquarePlus, MessagesSquare } from 'lucide-react'
import { Bee } from '../mascot'
import type { StewardContextRef } from '@taktflow/core'
import { useAsync } from '../../api'
import { Drawer, Menu, useStewardSuggestions, withShortcut } from '../ui'
import { StatTiles, type Tile } from '../viz'
import { fmtRelative } from '../../lib/format'
import { navigate, useLocation } from '../../lib/router'
import { closeSteward, useStewardDock } from '../../lib/ui-store'
import { pageKeyOf, usePageStewardContext } from './context'
import { ThreadView } from './thread-view'
import './steward.css'

const keyOf = (c: StewardContextRef) => `${c.type}:${c.id}`

const greeting = (h: number) => (h < 5 ? '夜深了' : h < 11 ? '早上好' : h < 13 ? '中午好' : h < 18 ? '下午好' : '晚上好')
const WEEK = '日一二三四五六'

/** 欢迎页的读数：当前空间的等你 / 阻塞 / 进行中，点一下就问对应的问题（回答是可视化块）。 */
function Brief({ onAsk }: { onAsk: (t: string) => void }) {
  const q = useAsync((ds) => ds.project(), [])
  if (!q.data) return null
  const { totals, attention } = q.data
  const tiles: Tile[] = [
    { key: 'wait', label: '等你', value: attention.length, tone: attention.length ? 'waiting' : undefined, onClick: () => onAsk('我有哪些待办？') },
    { key: 'blocked', label: '阻塞', value: totals.blocked, tone: totals.blocked ? 'failed' : undefined, onClick: () => onAsk('有什么风险？') },
    { key: 'active', label: '进行中', value: totals.active, tone: totals.active ? 'running' : undefined, onClick: () => onAsk('进度怎么样？') },
  ]
  return <StatTiles className="tiles-sm stw-brief" label="空间读数" tiles={tiles} />
}

/** 停靠面板的空状态：问候 + 空间读数（点了直接问）+ 本页短建议 + 最近会话（同名只留最新）。 */
function DockWelcome({ onAsk, onResume }: { onAsk: (t: string) => void; onResume: (id: string) => void }) {
  const { path } = useLocation()
  const page = pageKeyOf(path)
  const suggestions = useStewardSuggestions(page.page, page.id)
  // ux-audit: ok 最近会话是欢迎页的可选一节，没有会话时整节不显示
  const threads = useAsync((ds) => ds.stewardThreads(), [])
  const now = new Date()
  const recent = [...new Map((threads.data ?? []).map((t) => [t.title, t] as const)).values()]
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, 3)
  return (
    <div className="stw-welcome">
      <div className="stw-welcome-head">
        <Bee className="stw-welcome-icon" state="greet" size={48} interactive label="管家" />
        <div>
          <h3 className="stw-welcome-title">{greeting(now.getHours())}</h3>
          <p className="stw-welcome-body num">
            {now.getMonth() + 1} 月 {now.getDate()} 日 · 周{WEEK[now.getDay()]}
          </p>
        </div>
      </div>
      {page.page !== 'spaces' && <Brief onAsk={onAsk} />}
      {suggestions.length > 0 && (
        <div className="stw-welcome-sec">
          <div className="section-label">可以问</div>
          <div className="stw-chips">
            {suggestions.map((s, i) => (
              <button key={s} type="button" className="stw-chip pressable" style={{ '--i': i } as CSSProperties} onClick={() => onAsk(s)}>
                {s}
              </button>
            ))}
          </div>
        </div>
      )}
      {recent.length > 0 && (
        <div className="stw-welcome-sec">
          <div className="section-label">接着聊</div>
          <div className="stw-welcome-list">
            {recent.map((t) => (
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
  // ux-audit: ok 历史会话是下拉菜单的选项，没有时菜单不打开
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
      description="改动先出提案，批准后才执行"
      headerActions={
        <>
          <button type="button" className="btn btn-ghost btn-icon btn-sm" title="新会话" aria-label="新会话" onClick={fresh}>
            <MessageSquarePlus />
          </button>
          <button ref={historyBtn} type="button" className="btn btn-ghost btn-icon btn-sm" title="历史会话" aria-label="历史会话" aria-haspopup="menu" onClick={() => setHistory(true)}>
            <History />
          </button>
          <button type="button" className="btn btn-ghost btn-icon btn-sm" title={withShortcut('在整页打开', 'mod+j')} aria-label="在整页打开" onClick={() => navigate(`/solo${threadId ? `?thread=${threadId}` : ''}`)}>
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
