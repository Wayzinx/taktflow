import { useEffect, useSyncExternalStore, type ReactNode } from 'react'
import { BookOpen, ChevronRight, Inbox, LayoutDashboard, ListTodo, Monitor, Moon, Settings, Sun } from 'lucide-react'
import { useAsync, useSource } from '../api'
import { Link, useLocation } from '../lib/router'
import { REQ_STATUS } from '../lib/status'
import { useTheme, type ThemePref } from '../lib/theme'
import { StatusDot } from './ui'
import './layout.css'

// ---------------------------------------------------------------- 面包屑：页面声明，顶栏渲染

export interface Crumb {
  label: ReactNode
  to?: string
}
let crumbs: Crumb[] = []
const crumbSubs = new Set<() => void>()
export function useCrumbs(next: Crumb[], deps: unknown[]) {
  useEffect(() => {
    crumbs = next
    crumbSubs.forEach((f) => f())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)
}
function useCrumbState() {
  return useSyncExternalStore(
    (f) => {
      crumbSubs.add(f)
      return () => crumbSubs.delete(f)
    },
    () => crumbs,
  )
}

function Logo() {
  return (
    <svg viewBox="0 0 32 32" width="22" height="22" aria-hidden>
      <defs>
        <linearGradient id="lg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#7474ee" />
          <stop offset="1" stopColor="#4b4bc8" />
        </linearGradient>
      </defs>
      <rect width="32" height="32" rx="8" fill="url(#lg)" />
      <path d="M9 11h14M16 11v12" stroke="#fff" strokeWidth="2.6" strokeLinecap="round" />
      <circle cx="10" cy="21" r="2" fill="#fff" opacity=".7" />
      <circle cx="22" cy="21" r="2" fill="#fff" opacity=".7" />
    </svg>
  )
}

function ThemeSwitch() {
  const [pref, setPref] = useTheme()
  const opts: Array<{ v: ThemePref; icon: typeof Sun; label: string }> = [
    { v: 'system', icon: Monitor, label: '跟随系统' },
    { v: 'light', icon: Sun, label: '浅色' },
    { v: 'dark', icon: Moon, label: '深色' },
  ]
  return (
    <div className="theme-switch" role="radiogroup" aria-label="主题">
      {opts.map(({ v, icon: Icon, label }) => (
        <button key={v} role="radio" aria-checked={pref === v} className={pref === v ? 'on' : undefined} onClick={() => setPref(v)} title={label}>
          <Icon />
        </button>
      ))}
    </div>
  )
}

function Sidebar() {
  const { path } = useLocation()
  const project = useAsync((ds) => ds.project(), [])
  const pending = project.data?.attention.length ?? 0
  const items = [
    { to: '/', label: '总览', icon: LayoutDashboard, active: path === '/' },
    { to: '/requirements', label: '需求', icon: ListTodo, active: path.startsWith('/req') || path.startsWith('/run'), count: project.data?.totals.requirements },
    { to: '/attention', label: '待办', icon: Inbox, active: path === '/attention', badge: pending },
    { to: '/knowledge', label: '知识源', icon: BookOpen, active: path === '/knowledge', soon: true },
    { to: '/settings', label: '设置', icon: Settings, active: path === '/settings' },
  ]
  const recent = project.data?.requirements.slice(0, 6) ?? []
  return (
    <aside className="sidebar">
      <div className="sb-brand">
        <Logo />
        <div className="sb-brand-text">
          <div className="sb-product">taktflow</div>
          <div className="sb-project truncate">{project.data?.name ?? '…'}</div>
        </div>
      </div>
      <nav className="sb-nav">
        {items.map(({ to, label, icon: Icon, active, badge, count, soon }) => (
          <Link key={to} to={to} className={`sb-item${active ? ' active' : ''}`}>
            <Icon />
            <span>{label}</span>
            {badge ? <span className="sb-badge num">{badge}</span> : null}
            {count !== undefined && !badge ? <span className="sb-count num">{count}</span> : null}
            {soon && <span className="sb-soon">占位</span>}
          </Link>
        ))}
      </nav>
      {recent.length > 0 && (
        <div className="sb-section">
          <div className="sb-section-title">需求</div>
          {recent.map((r) => (
            <Link key={r.id} to={`/req/${r.id}`} className={`sb-req${path === `/req/${r.id}` ? ' active' : ''}`}>
              <StatusDot tone={REQ_STATUS[r.status].tone} pulse={r.stages.some((s) => s.status === 'running')} />
              <span className="mono sb-req-id">{r.id}</span>
              <span className="truncate">{r.title}</span>
            </Link>
          ))}
        </div>
      )}
      <div className="sb-foot">
        <ThemeSwitch />
        <span className="sb-version mono">v0.1.0</span>
      </div>
    </aside>
  )
}

function Topbar() {
  const items = useCrumbState()
  const ds = useSource()
  return (
    <header className="topbar">
      <nav className="crumbs" aria-label="面包屑">
        {items.map((c, i) => (
          <span key={i} className="crumb">
            {i > 0 && <ChevronRight className="crumb-sep" />}
            {c.to && i < items.length - 1 ? <Link to={c.to}>{c.label}</Link> : <span className={i === items.length - 1 ? 'crumb-current' : undefined}>{c.label}</span>}
          </span>
        ))}
      </nav>
      <span style={{ flex: 1 }} />
      {ds.mock && (
        <span className="demo-badge" title="后端 API 不可达或指定了 ?mock=1，当前展示内置演示数据；写操作只保存在本页内存里">
          <span className="demo-dot" />
          演示数据
        </span>
      )}
    </header>
  )
}

export function AppShell({ children }: { children: ReactNode }) {
  return (
    <div className="shell">
      <Sidebar />
      <div className="shell-main">
        <Topbar />
        <main className="shell-content">{children}</main>
      </div>
    </div>
  )
}

export function PageHeader({ title, sub, actions, icon }: { title: ReactNode; sub?: ReactNode; actions?: ReactNode; icon?: ReactNode }) {
  return (
    <div className="page-header">
      {icon}
      <div style={{ minWidth: 0, flex: 1 }}>
        <h1 className="page-title">{title}</h1>
        {sub && <div className="page-sub">{sub}</div>}
      </div>
      {actions && <div className="page-actions">{actions}</div>}
    </div>
  )
}
