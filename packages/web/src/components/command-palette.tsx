import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { CornerDownLeft, FileText, Inbox, LayoutDashboard, ListTodo, Monitor, Moon, Play, Search, Settings, Sun, BookOpen, type LucideIcon } from 'lucide-react'
import { useAsync } from '../api'
import { fmtRelative } from '../lib/format'
import { navigate } from '../lib/router'
import { REQ_STATUS, RUN_STATUS, toneVar } from '../lib/status'
import { setTheme } from '../lib/theme'
import { TaktLoader } from './takt'
import './command-palette.css'

// ---------------------------------------------------------------- 开关：⌘K / Ctrl+K，或顶栏按钮

// ?cmdk=1 首屏直接打开（截图与端到端测试用）
let open = new URLSearchParams(location.search).get('cmdk') === '1'
const subs = new Set<() => void>()
export function setPaletteOpen(v: boolean) {
  open = v
  subs.forEach((f) => f())
}
function usePaletteOpen() {
  return useSyncExternalStore(
    (f) => {
      subs.add(f)
      return () => subs.delete(f)
    },
    () => open,
  )
}

interface Item {
  id: string
  group: '页面' | '需求' | '运行' | '操作'
  label: string
  /** 等宽显示的标识（REQ-001、run id） */
  code?: string
  hint?: string
  icon: LucideIcon
  tone?: string
  keywords: string
  run: () => void
}

const PAGES: Array<[string, string, LucideIcon, string]> = [
  ['/', '总览', LayoutDashboard, 'overview home zonglan'],
  ['/requirements', '需求列表', ListTodo, 'requirements xuqiu'],
  ['/attention', '待办', Inbox, 'attention todo daiban'],
  ['/knowledge', '知识源', BookOpen, 'knowledge zhishi'],
  ['/settings', '设置：模型与 harness', Settings, 'settings models harness shezhi'],
]

function useItems(active: boolean): { items: Item[]; loading: boolean } {
  const reqs = useAsync((ds) => (active ? ds.requirements() : Promise.resolve([])), [active])
  const runs = useAsync((ds) => (active ? ds.runs() : Promise.resolve([])), [active])
  const items = useMemo(() => {
    const out: Item[] = PAGES.map(([to, label, icon, kw]) => ({ id: `page:${to}`, group: '页面', label, icon, keywords: kw, run: () => navigate(to) }))
    for (const r of reqs.data ?? []) {
      const st = REQ_STATUS[r.status]
      out.push({ id: `req:${r.id}`, group: '需求', label: r.title, code: r.id, hint: st.label, icon: FileText, tone: toneVar(st.tone), keywords: `${r.id} ${r.title}`, run: () => navigate(`/req/${r.id}`) })
    }
    const sorted = [...(runs.data ?? [])].sort((a, b) => b.startedAt.localeCompare(a.startedAt))
    for (const r of sorted.slice(0, 30)) {
      const st = RUN_STATUS[r.status]
      out.push({
        id: `run:${r.runId}`,
        group: '运行',
        label: r.origin?.title ?? `${r.requirementId} · ${r.workflowId}`,
        code: r.runId,
        hint: `${st.label} · ${fmtRelative(r.startedAt)}`,
        icon: Play,
        tone: toneVar(st.tone),
        keywords: `${r.runId} ${r.requirementId} ${r.workflowId} ${r.origin?.title ?? ''}`,
        run: () => navigate(`/run/${r.runId}`),
      })
    }
    out.push(
      { id: 'theme:light', group: '操作', label: '切换到浅色主题', icon: Sun, keywords: 'theme light 浅色 主题', run: () => setTheme('light') },
      { id: 'theme:dark', group: '操作', label: '切换到深色主题', icon: Moon, keywords: 'theme dark 深色 主题', run: () => setTheme('dark') },
      { id: 'theme:system', group: '操作', label: '主题跟随系统', icon: Monitor, keywords: 'theme system 系统 主题', run: () => setTheme('system') },
    )
    return out
  }, [reqs.data, runs.data])
  return { items, loading: reqs.loading || runs.loading }
}

/** 所有空格分开的词都要命中；标识前缀命中排前面。 */
function filter(items: Item[], q: string): Item[] {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean)
  if (!words.length) {
    let runs = 0
    return items.filter((i) => i.group !== '运行' || runs++ < 6)
  }
  const scored: Array<[Item, number]> = []
  for (const it of items) {
    const hay = `${it.label} ${it.keywords}`.toLowerCase()
    if (!words.every((w) => hay.includes(w))) continue
    const first = words[0]!
    const code = it.code?.toLowerCase() ?? ''
    scored.push([it, code.startsWith(first) ? 0 : it.label.toLowerCase().startsWith(first) ? 1 : 2])
  }
  return scored.sort((a, b) => a[1] - b[1]).map(([it]) => it)
}

export function CommandPalette() {
  const isOpen = usePaletteOpen()
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setPaletteOpen(!open)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
  return isOpen ? <PaletteDialog /> : null
}

function PaletteDialog() {
  const [q, setQ] = useState('')
  const [sel, setSel] = useState(0)
  const { items, loading } = useItems(true)
  const results = useMemo(() => filter(items, q), [items, q])
  const listRef = useRef<HTMLDivElement>(null)
  const restore = useRef<Element | null>(document.activeElement)

  useEffect(() => setSel(0), [q])
  useEffect(() => {
    listRef.current?.querySelector(`[data-idx="${sel}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [sel])
  useEffect(() => () => (restore.current as HTMLElement | null)?.focus?.(), [])

  const close = () => setPaletteOpen(false)
  const pick = (it: Item | undefined) => {
    if (!it) return
    close()
    it.run()
  }
  const onKey = (e: ReactKeyboardEvent) => {
    if (e.key === 'Escape') close()
    else if (e.key === 'ArrowDown') setSel((s) => Math.min(s + 1, results.length - 1))
    else if (e.key === 'ArrowUp') setSel((s) => Math.max(s - 1, 0))
    else if (e.key === 'Enter') pick(results[sel])
    else return
    e.preventDefault()
  }

  let lastGroup = ''
  return (
    <div className="cmdk-scrim" onMouseDown={close}>
      <div className="cmdk" role="dialog" aria-modal="true" aria-label="命令面板" onMouseDown={(e) => e.stopPropagation()} onKeyDown={onKey}>
        <div className="cmdk-input-row">
          <Search aria-hidden />
          <input
            autoFocus
            className="cmdk-input"
            placeholder="搜索需求、运行或页面…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            role="combobox"
            aria-expanded="true"
            aria-controls="cmdk-list"
            aria-activedescendant={results[sel] ? `cmdk-${sel}` : undefined}
          />
          <span className="kbd">Esc</span>
        </div>
        <div className="cmdk-list" id="cmdk-list" role="listbox" ref={listRef}>
          {results.map((it, i) => {
            const head = it.group !== lastGroup ? it.group : null
            lastGroup = it.group
            const Icon = it.icon
            return (
              <div key={it.id}>
                {head && <div className="cmdk-group">{head}</div>}
                <div
                  id={`cmdk-${i}`}
                  data-idx={i}
                  role="option"
                  aria-selected={i === sel}
                  className={`cmdk-item${i === sel ? ' on' : ''}`}
                  onMouseMove={() => i !== sel && setSel(i)}
                  onClick={() => pick(it)}
                >
                  <Icon className="cmdk-icon" style={it.tone ? { color: it.tone } : undefined} aria-hidden />
                  {it.code && <span className="mono cmdk-code">{it.code}</span>}
                  <span className="truncate cmdk-label">{it.label}</span>
                  {it.hint && <span className="cmdk-hint">{it.hint}</span>}
                  {i === sel && <CornerDownLeft className="cmdk-enter" aria-hidden />}
                </div>
              </div>
            )
          })}
          {!results.length && (loading ? <TaktLoader compact label="正在读取需求与运行" /> : <div className="cmdk-empty">没有匹配“{q}”的需求、运行或页面</div>)}
        </div>
        <div className="cmdk-foot">
          <span><span className="kbd">↑</span> <span className="kbd">↓</span> 选择</span>
          <span><span className="kbd">↵</span> 打开</span>
          <span className="cmdk-foot-count num">{results.length} 项</span>
        </div>
      </div>
    </div>
  )
}
