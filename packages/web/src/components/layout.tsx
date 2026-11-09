import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { usePresence } from '../lib/motion'
import { BookOpen, ChevronRight, FlaskConical, Inbox, LayoutDashboard, ListTodo, Menu, Monitor, Moon, PanelLeftClose, PanelLeftOpen, Plus, Search, Settings, Sparkles, Sun, Workflow, X } from 'lucide-react'
import { invalidate, useAsync, useSource } from '../api'
import { Link, useLocation } from '../lib/router'
import { SHORTCUTS, shortcutLabel } from '../lib/shortcuts'
import { openCreateRequirement, setStewardUnread, toggleSidebar, toggleSteward, useSidebarCollapsed, useStewardDock, useStewardUnread } from '../lib/ui-store'
import { PageHeader } from './ui/page-header'
import { PageTransition } from './ui/page-transition'
import { REQ_STATUS } from '../lib/status'
import { useTheme, type ThemePref } from '../lib/theme'
import { CommandPalette, setPaletteOpen } from './command-palette'
import { SpaceSwitcher } from './space-switcher'
import { TaktBeat } from './takt'
import { GlideMark, StatusDot, useGlide } from './ui'
import { Bee } from './mascot'
import './layout.css'
import './topbar.css'
import { usePulse } from './pulse'

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

/** 品牌标：节拍蜂，只做轻量动作（张望、天线、伸翅膀、小跳、绕圈），间隔拉长。 */
function Logo() {
  return <Bee className="logo" size={28} logo gapScale={1.8} interactive label="taktflow" />
}

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform)
const tip = (label: string, combo: string) => `${label}（${shortcutLabel(combo)}）`

/** 管家未读数：首屏取 /steward/feed 里最近的 unread，之后跟 /steward/stream。 */
function useStewardUnreadSync() {
  const ds = useSource()
  useEffect(() => {
    let alive = true
    void ds
      .stewardFeed()
      .then((items) => {
        const last = items.find((i) => i.type === 'unread')
        if (alive && last && last.type === 'unread') setStewardUnread(last.count)
      })
      .catch(() => undefined)
    const off = ds.subscribeStewardFeed((item) => {
      if (item.type === 'unread') setStewardUnread(item.count)
    })
    return () => {
      alive = false
      off()
    }
  }, [ds])
}

/** 导轨顶部：空间切换器右侧的三个图标按钮（管家 ⌘J / 搜索 ⌘K / 收起 ⌘B）。 */
function RailTools({ collapsed }: { collapsed: boolean }) {
  const unread = useStewardUnread()
  const dock = useStewardDock()
  const Collapse = collapsed ? PanelLeftOpen : PanelLeftClose
  return (
    <div className="sb-tools">
      <button type="button" className={`sb-tool${dock.open ? ' on' : ''}`} onClick={toggleSteward} title={tip('管家', SHORTCUTS.steward)} aria-label={`管家${unread ? `，${unread} 条未读` : ''}`} aria-pressed={dock.open}>
        <Sparkles aria-hidden />
        {unread > 0 && <span className="sb-tool-dot num">{unread > 9 ? '9+' : unread}</span>}
      </button>
      <button type="button" className="sb-tool" onClick={() => setPaletteOpen(true)} title={tip('搜索或跳转', SHORTCUTS.palette)} aria-label="搜索或跳转">
        <Search aria-hidden />
      </button>
      <button type="button" className="sb-tool sb-tool-collapse" onClick={toggleSidebar} title={tip(collapsed ? '展开侧栏' : '收起侧栏', SHORTCUTS.sidebar)} aria-label={collapsed ? '展开侧栏' : '收起侧栏'}>
        <Collapse aria-hidden />
      </button>
    </div>
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
        <button key={v} role="radio" aria-checked={pref === v} aria-label={label} className={pref === v ? 'on' : undefined} onClick={() => setPref(v)} title={label}>
          <Icon aria-hidden />
        </button>
      ))}
    </div>
  )
}

function Sidebar({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { path } = useLocation()
  const collapsed = useSidebarCollapsed()
  const project = useAsync((ds) => ds.project(), [])
  const pending = project.data?.attention.length ?? 0
  const items = [
    { to: '/solo', label: 'Solo', icon: Sparkles, active: path === '/solo' },
    { to: '/', label: '总览', icon: LayoutDashboard, active: path === '/' },
    { to: '/requirements', label: '需求', icon: ListTodo, active: path.startsWith('/req') || path.startsWith('/run'), count: project.data?.totals.requirements, create: true },
    { to: '/attention', label: '待办', icon: Inbox, active: path === '/attention', badge: pending },
    { to: '/knowledge', label: '知识库', icon: BookOpen, active: path.startsWith('/knowledge') },
    { to: '/workflows', label: 'Workflow', icon: Workflow, active: path.startsWith('/workflows') },
    { to: '/eval', label: '评测', icon: FlaskConical, active: path === '/eval' },
    { to: '/settings', label: '空间设置', icon: Settings, active: path.startsWith('/settings') },
  ]
  const recent = project.data?.requirements.slice(0, 6) ?? []
  const [navRef, glide] = useGlide<HTMLElement>('.sb-item.active')
  return (
    <aside className={`sidebar${open ? ' open' : ''}${collapsed ? ' collapsed' : ''}`} aria-label="主导航">
      <div className="sb-brand">
        <Logo />
        <SpaceSwitcher fallbackName={project.data?.name} />
        <RailTools collapsed={collapsed} />
        <button className="sb-close btn-icon" onClick={onClose} aria-label="收起导航">
          <X aria-hidden />
        </button>
      </div>
      <nav ref={navRef} className={`sb-nav${glide ? ' has-glide' : ''}`}>
        <GlideMark glide={glide} className="sb-glide" />
        {items.map(({ to, label, icon: Icon, active, badge, count, create }) => (
          <div key={to} className={`sb-row${create ? ' has-create' : ''}`}>
            <Link to={to} className={`sb-item${active ? ' active' : ''}`} aria-current={active ? 'page' : undefined} title={collapsed ? label : undefined}>
              <Icon aria-hidden />
              <span className="sb-label">{label}</span>
              {badge ? <span className="sb-badge num" aria-label={`${badge} 项待办`}>{badge}</span> : null}
              {count !== undefined && !badge ? <span className="sb-count num">{count}</span> : null}
            </Link>
            {create && (
              <button type="button" className="sb-create" onClick={() => openCreateRequirement()} title={tip('新建需求', SHORTCUTS.createRequirement)} aria-label="新建需求">
                <Plus aria-hidden />
              </button>
            )}
          </div>
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
        <span className="sb-lockup">
          <Bee size={22} logo gapScale={2.2} />
          <span className="sb-version mono">taktflow v0.1.0</span>
        </span>
      </div>
    </aside>
  )
}

function Topbar({ onMenu }: { onMenu: () => void }) {
  const items = useCrumbState()
  const ds = useSource()
  const project = useAsync((d) => d.project(), [])
  const running = project.data?.requirements.filter((r) => r.stages.some((s) => s.status === 'running')).length ?? 0
  return (
    <header className="topbar">
      <button className="btn btn-ghost btn-icon topbar-menu" onClick={onMenu} aria-label="打开导航">
        <Menu aria-hidden />
      </button>
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
      <button className="btn btn-sm topbar-search" onClick={() => setPaletteOpen(true)} aria-label="打开命令面板" title={tip("搜索或跳转", SHORTCUTS.palette)}>
        <Search aria-hidden />
        <span className="kbd">{isMac ? '⌘K' : 'Ctrl K'}</span>
      </button>
      <span className={`takt-track${running > 0 ? ' running' : ''}`} aria-hidden />
    </header>
  )
}

export function AppShell({ children }: { children: ReactNode }) {
  const [navOpen, setNavOpen] = useState(false)
  const { path, spaceId } = useLocation()
  const collapsed = useSidebarCollapsed()
  const dockOpen = useStewardDock().open
  useStewardUnreadSync()
  usePulse()
  useEffect(() => setNavOpen(false), [path])
  // 切换空间：所有查询按新空间重新拉取
  const lastSpace = useRef(spaceId)
  useEffect(() => {
    if (lastSpace.current === spaceId) return
    lastSpace.current = spaceId
    invalidate()
  }, [spaceId])
  return (
    <div className={`shell${collapsed ? ' rail-collapsed' : ''}`} data-dock={dockOpen ? 'open' : undefined}>
      <a className="skip-link" href="#main">跳到正文</a>
      <Sidebar open={navOpen} onClose={() => setNavOpen(false)} />
      <NavScrim open={navOpen} onClose={() => setNavOpen(false)} />
      <div className="shell-main">
        <Topbar onMenu={() => setNavOpen(true)} />
        <main className="shell-content" id="main">
          <PageTransition routeKey={`${spaceId ?? ''}${path}`}>{children}</PageTransition>
        </main>
      </div>
      <CommandPalette />
    </div>
  )
}

/** 统一页头已移到 components/ui/page-header（M4）；这里保留旧的导入路径。 */
export { PageHeader }

/** 窄屏导轨的遮罩：与导轨同进同出（usePresence 保留退出帧）。 */
function NavScrim({ open, onClose }: { open: boolean; onClose: () => void }) {
  const p = usePresence(open, 150)
  if (!p.mounted) return null
  return <div className="sb-scrim presence-scrim" data-state={p.state} onClick={onClose} />
}
