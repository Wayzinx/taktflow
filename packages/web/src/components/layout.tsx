import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { usePresence } from '../lib/motion'
import { BookOpen, ChevronRight, FlaskConical, Inbox, LayoutDashboard, ListTodo, Menu, Monitor, Moon, Search, Settings, Sun, Workflow, X } from 'lucide-react'
import { invalidate, useAsync, useSource } from '../api'
import { Link, useLocation } from '../lib/router'
import { REQ_STATUS } from '../lib/status'
import { useTheme, type ThemePref } from '../lib/theme'
import { CommandPalette, setPaletteOpen } from './command-palette'
import { SpaceSwitcher } from './space-switcher'
import { TaktBeat } from './takt'
import { StatusDot } from './ui'
import './layout.css'
import './topbar.css'

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

/** 品牌标：三道节拍刻度，最后一拍是节拍橙。 */
function Logo() {
  return (
    <svg className="logo" viewBox="0 0 28 28" width="26" height="26" aria-hidden>
      <rect x="0.5" y="0.5" width="27" height="27" rx="6.5" className="logo-plate" />
      <rect x="7" y="9" width="2.6" height="10" rx="1.3" className="logo-tick" />
      <rect x="12.7" y="9" width="2.6" height="10" rx="1.3" className="logo-tick" />
      <rect x="18.4" y="6" width="2.6" height="16" rx="1.3" className="logo-beat" />
    </svg>
  )
}

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform)

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
        <button key={v} role="radio" aria-checked={pref === v} aria-label={label} className={pref === v ? 'on' : undefined} onClick={() => setPref(v)} title={label}>
          <Icon aria-hidden />
        </button>
      ))}
    </div>
  )
}

function Sidebar({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { path, query } = useLocation()
  const onKnowledge = path === '/settings' && query.get('tab') === 'knowledge'
  const project = useAsync((ds) => ds.project(), [])
  const pending = project.data?.attention.length ?? 0
  const items = [
    { to: '/', label: '总览', icon: LayoutDashboard, active: path === '/' },
    { to: '/requirements', label: '需求', icon: ListTodo, active: path.startsWith('/req') || path.startsWith('/run'), count: project.data?.totals.requirements },
    { to: '/attention', label: '待办', icon: Inbox, active: path === '/attention', badge: pending },
    { to: '/settings?tab=knowledge', label: '知识源', icon: BookOpen, active: onKnowledge },
    { to: '/workflows', label: 'Workflow', icon: Workflow, active: path.startsWith('/workflows') },
    { to: '/eval', label: '评测', icon: FlaskConical, active: path === '/eval' },
    { to: '/settings', label: '空间设置', icon: Settings, active: path.startsWith('/settings') && !onKnowledge },
  ]
  const recent = project.data?.requirements.slice(0, 6) ?? []
  return (
    <aside className={`sidebar${open ? ' open' : ''}`} aria-label="主导航">
      <div className="sb-brand">
        <Logo />
        <SpaceSwitcher fallbackName={project.data?.name} />
        <button className="sb-close btn-icon" onClick={onClose} aria-label="收起导航">
          <X aria-hidden />
        </button>
      </div>
      <button className="sb-search" onClick={() => setPaletteOpen(true)}>
        <Search aria-hidden />
        <span>搜索或跳转</span>
        <span className="sb-kbd mono">{isMac ? '⌘' : 'Ctrl'} K</span>
      </button>
      <nav className="sb-nav">
        {items.map(({ to, label, icon: Icon, active, badge, count }) => (
          <Link key={to} to={to} className={`sb-item${active ? ' active' : ''}`} aria-current={active ? 'page' : undefined}>
            <Icon aria-hidden />
            <span>{label}</span>
            {badge ? <span className="sb-badge num" aria-label={`${badge} 项待办`}>{badge}</span> : null}
            {count !== undefined && !badge ? <span className="sb-count num">{count}</span> : null}
          </Link>
        ))}
      </nav>
      {recent.length > 0 && (
        <div className="sb-section">
          <div className="sb-section-title">最近的需求</div>
          {recent.map((r) => (
            <Link key={r.id} to={`/req/${r.id}`} className={`sb-req${path === `/req/${r.id}` ? ' active' : ''}`} title={`${r.id} ${r.title} · ${REQ_STATUS[r.status].label}`}>
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

/** 嵌入模式没有侧栏：主要入口放到顶栏左侧的 Tab。 */
function EmbeddedTabs() {
  const { path, query } = useLocation()
  const project = useAsync((ds) => ds.project(), [])
  const pending = project.data?.attention.length ?? 0
  const items = [
    { to: '/', label: '总览', icon: LayoutDashboard, active: path === '/' },
    { to: '/requirements', label: '需求', icon: ListTodo, active: path.startsWith('/req') || path.startsWith('/run') },
    { to: '/attention', label: '待办', icon: Inbox, active: path === '/attention', badge: pending },
    { to: '/eval', label: '评测', icon: FlaskConical, active: path === '/eval' },
    { to: '/workflows', label: 'Workflow', icon: Workflow, active: path.startsWith('/workflows') },
    { to: '/settings', label: '空间设置', icon: Settings, active: path.startsWith('/settings') && query.get('tab') !== 'knowledge' },
  ]
  return (
    <nav className="embed-tabs" aria-label="taktflow">
      {items.map(({ to, label, icon: Icon, active, badge }) => (
        <Link key={to} to={to} className={`embed-tab${active ? ' active' : ''}`} aria-current={active ? 'page' : undefined}>
          <Icon aria-hidden />
          <span>{label}</span>
          {badge ? <span className="sb-badge num" aria-label={`${badge} 项待办`}>{badge}</span> : null}
        </Link>
      ))}
    </nav>
  )
}

function Topbar({ onMenu, embedded = false }: { onMenu: () => void; embedded?: boolean }) {
  const items = useCrumbState()
  const ds = useSource()
  const project = useAsync((d) => d.project(), [])
  const running = project.data?.requirements.filter((r) => r.stages.some((s) => s.status === 'running')).length ?? 0
  return (
    <header className="topbar">
      {embedded ? (
        <EmbeddedTabs />
      ) : (
        <button className="btn btn-ghost btn-icon topbar-menu" onClick={onMenu} aria-label="打开导航">
          <Menu aria-hidden />
        </button>
      )}
      <nav className="crumbs" aria-label="面包屑">
        <ol>
          {items.map((c, i) => (
            <li key={i} className="crumb">
              {i > 0 && <ChevronRight className="crumb-sep" aria-hidden />}
              {c.to && i < items.length - 1 ? (
                <Link to={c.to}>{c.label}</Link>
              ) : (
                <span className={i === items.length - 1 ? 'crumb-current' : undefined} aria-current={i === items.length - 1 ? 'page' : undefined}>
                  {c.label}
                </span>
              )}
            </li>
          ))}
        </ol>
      </nav>
      <span className="topbar-spacer" />
      {ds.mock && (
        <span className="demo-badge" title="后端 API 不可达或指定了 ?mock=1，当前展示内置演示数据；写操作只保存在本页内存里">
          演示数据
        </span>
      )}
      {project.data && <TaktBeat count={running} />}
      {!embedded && (
        <button className="btn btn-sm topbar-search" onClick={() => setPaletteOpen(true)} aria-label="打开命令面板">
          <Search aria-hidden />
          <span className="kbd">{isMac ? '⌘K' : 'Ctrl K'}</span>
        </button>
      )}
    </header>
  )
}

/**
 * 应用外壳。embedded：嵌入宿主时没有侧栏、空间切换和命令面板（⌘K 归宿主），入口在顶栏 Tab；
 * 内容在 shell-main 里滚动。
 */
export function AppShell({ children, variant = 'standalone' }: { children: ReactNode; variant?: 'standalone' | 'embedded' }) {
  const [navOpen, setNavOpen] = useState(false)
  const { path, spaceId } = useLocation()
  useEffect(() => setNavOpen(false), [path])
  // 切换空间：所有查询按新空间重新拉取
  const lastSpace = useRef(spaceId)
  useEffect(() => {
    if (lastSpace.current === spaceId) return
    lastSpace.current = spaceId
    invalidate()
  }, [spaceId])
  if (variant === 'embedded') {
    return (
      <div className="shell shell-embedded">
        <div className="shell-main">
          <Topbar onMenu={() => undefined} embedded />
          <main className="shell-content" id="main">
            {children}
          </main>
        </div>
      </div>
    )
  }
  return (
    <div className="shell">
      <a className="skip-link" href="#main">跳到正文</a>
      <Sidebar open={navOpen} onClose={() => setNavOpen(false)} />
      <NavScrim open={navOpen} onClose={() => setNavOpen(false)} />
      <div className="shell-main">
        <Topbar onMenu={() => setNavOpen(true)} />
        <main className="shell-content" id="main">
          {children}
        </main>
      </div>
      <CommandPalette />
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

/** 窄屏导轨的遮罩：与导轨同进同出（usePresence 保留退出帧）。 */
function NavScrim({ open, onClose }: { open: boolean; onClose: () => void }) {
  const p = usePresence(open, 150)
  if (!p.mounted) return null
  return <div className="sb-scrim presence-scrim" data-state={p.state} onClick={onClose} />
}
