import { lazy, Suspense, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { usePresence } from '../lib/motion'
import { BookOpen, Boxes, ChevronRight, FlaskConical, Inbox, LayoutDashboard, ListTodo, Menu, MessagesSquare, Monitor, Moon, PanelLeftClose, PanelLeftOpen, Plus, Search, Settings, Sun, Workflow, X, Zap } from 'lucide-react'
import { invalidate, useAsync, useSource } from '../api'
import { Link, useLocation } from '../lib/router'
import { spacePath } from '../lib/space'
import { SHORTCUTS, shortcutLabel } from '../lib/shortcuts'
import { openCreateRequirement, setStewardUnread, toggleSidebar, toggleSteward, useSidebarCollapsed, useStewardDock, useStewardUnread } from '../lib/ui-store'
import { PageHeader } from './ui/page-header'
import { PageTransition } from './ui/page-transition'
import { REQ_STATUS } from '../lib/status'
import { useTheme, type ThemePref } from '../lib/theme'
import { CommandPalette, setPaletteOpen } from './command-palette'
import { SpaceSwitcher } from './space-switcher'
import { TaktBeat } from './takt'
import { GlideMark, SkeletonRows, StatusDot, useGlide } from './ui'
import { Bee } from './mascot'
import './layout.css'
import './topbar.css'
import { usePulse } from './pulse'
import { BeeGlyph } from './identity'
import { onTabReturn } from '../lib/visible'

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
    const load = () =>
      void ds
        .stewardFeed()
        .then((items) => {
          const last = items.find((i) => i.type === 'unread')
          if (alive && last && last.type === 'unread') setStewardUnread(last.count)
        })
        .catch(() => undefined)
    load()
    const off = ds.subscribeStewardFeed((item) => {
      if (item.type === 'unread') setStewardUnread(item.count)
    })
    // 后台标签页的流断开过，回来补拉一次未读数
    const offReturn = onTabReturn(load)
    return () => {
      alive = false
      off()
      offReturn()
    }
  }, [ds])
}

/** 导轨顶部的图标按钮：管家停靠面板 ⌘J（只在空间模式；管家模式本身就是整页对话）/ 搜索 ⌘K / 收起 ⌘B。 */
function RailTools({ collapsed, mode }: { collapsed: boolean; mode: RailMode }) {
  const unread = useStewardUnread()
  const dock = useStewardDock()
  const Collapse = collapsed ? PanelLeftOpen : PanelLeftClose
  return (
    <div className="sb-tools">
      {mode === 'space' && (
        <button type="button" className={`sb-tool${dock.open ? ' on' : ''}`} onClick={toggleSteward} title={tip('在旁边问管家', SHORTCUTS.steward)} aria-label={`在旁边问管家${unread ? `，${unread} 条未读` : ''}`} aria-pressed={dock.open}>
          <MessagesSquare aria-hidden />
          {unread > 0 && <span className="sb-tool-dot num">{unread > 9 ? '9+' : unread}</span>}
        </button>
      )}
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

export type RailMode = 'solo' | 'space'

/** Solo 模式的左栏（新对话 + 会话 / 动态）跟着 Solo 页一起按需加载。 */
const SoloRail = lazy(() => import('../pages/solo/rail'))

/** 两种模式各记住最后去过的地址：切回来时回到原处（Solo 回到原会话，空间回到原页面）。 */
const lastHref: Record<RailMode, string> = { solo: '/solo', space: '/' }

/**
 * 侧栏分两种模式（docs/design/29）：
 * - Solo：和管家直接对话，左栏是新对话、会话和动态，跨空间；
 * - 空间：空间选择 + 总览、需求、待办等导航 + 最近的需求。
 */
function Sidebar({ open, onClose, mode }: { open: boolean; onClose: () => void; mode: RailMode }) {
  const collapsed = useSidebarCollapsed()
  const modes = [
    { mode: 'solo' as const, label: '管家', icon: BeeGlyph, title: '和管家对话：问进度、查原因、让它代办；跨空间看需求、运行和节点' },
    { mode: 'space' as const, label: '空间', icon: Boxes, title: '当前空间的总览、需求、待办与设置' },
  ]
  return (
    <aside className={`sidebar${open ? ' open' : ''}${collapsed ? ' collapsed' : ''}`} data-mode={mode} aria-label="主导航">
      <div className="sb-brand">
        <Logo />
        <span className="sb-product">taktflow</span>
        <RailTools collapsed={collapsed} mode={mode} />
        <button className="sb-close btn-icon" onClick={onClose} aria-label="收起导航">
          <X aria-hidden />
        </button>
      </div>
      <nav className="sb-modes" aria-label="模式">
        {modes.map(({ mode: m, label, icon: Icon, title }) => (
          <Link key={m} to={lastHref[m]} className="sb-mode" aria-current={m === mode ? 'page' : undefined} title={collapsed ? label : title}>
            <Icon aria-hidden />
            <span className="sb-label">{label}</span>
          </Link>
        ))}
      </nav>
      {mode === 'solo' ? (
        <Suspense fallback={<SkeletonRows rows={5} />}>
          <SoloRail collapsed={collapsed} />
        </Suspense>
      ) : (
        <SpaceRail collapsed={collapsed} />
      )}
      <div className="sb-foot">
        <ThemeSwitch />
        <span className="sb-version mono">v0.1.0</span>
      </div>
    </aside>
  )
}

function SpaceRail({ collapsed }: { collapsed: boolean }) {
  const { path } = useLocation()
  const project = useAsync((ds) => ds.project(), [])
  const pending = project.data?.attention.length ?? 0
  const items = [
    { to: '/', label: '总览', icon: LayoutDashboard, motion: 'tiles', active: path === '/' },
    { to: '/requirements', label: '需求', icon: ListTodo, motion: 'drop', active: path.startsWith('/req') || path.startsWith('/run'), count: project.data?.totals.requirements, create: true },
    { to: '/attention', label: '待办', icon: Inbox, motion: 'pop', active: path === '/attention', badge: pending },
    { to: '/knowledge', label: '知识库', icon: BookOpen, motion: 'open', active: path.startsWith('/knowledge') },
    { to: '/workflows', label: 'Workflow', icon: Workflow, motion: 'shift', active: path.startsWith('/workflows') },
    { to: '/eval', label: '评测', icon: FlaskConical, motion: 'swing', active: path === '/eval' },
    { to: '/automations', label: '自动化', icon: Zap, motion: 'jolt', active: path === '/automations' },
    { to: '/settings', label: '空间设置', icon: Settings, motion: 'turn', active: path.startsWith('/settings') },
  ]
  const recent = project.data?.requirements.slice(0, 6) ?? []
  const [navRef, glide] = useGlide<HTMLElement>('.sb-item.active')
  return (
    <>
      <div className="sb-space">
        <SpaceSwitcher fallbackName={project.data?.name} />
      </div>
      <nav ref={navRef} className={`sb-nav${glide ? ' has-glide' : ''}`} aria-label="空间">
        <GlideMark glide={glide} className="sb-glide" />
        {items.map(({ to, label, icon: Icon, motion, active, badge, count, create }) => (
          <div key={to} className={`sb-row${create ? ' has-create' : ''}`}>
            <Link to={to} className={`sb-item${active ? ' active' : ''}`} aria-current={active ? 'page' : undefined} title={collapsed ? label : undefined}>
              <Icon aria-hidden data-motion={motion} />
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
    </>
  )
}

function Topbar({ onMenu }: { onMenu: () => void }) {
  const items = useCrumbState()
  const ds = useSource()
  const project = useAsync((d) => d.project(), [])
  const running = project.data?.requirements.filter((r) => r.stages.some((s) => s.status === 'running')).length ?? 0
  // 分隔线只在内容滚到顶栏下面时出现（docs/design/30 §1）；滚动容器是外壳的工作区面板
  const bar = useRef<HTMLElement>(null)
  const [scrolled, setScrolled] = useState(false)
  useEffect(() => {
    const scroller = bar.current?.closest('.shell-main')
    if (!scroller) return
    const on = () => setScrolled(scroller.scrollTop > 2)
    on()
    scroller.addEventListener('scroll', on, { passive: true })
    return () => scroller.removeEventListener('scroll', on)
  }, [])
  return (
    <header ref={bar} className={`topbar${scrolled ? ' is-scrolled' : ''}`}>
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
    </header>
  )
}

export function AppShell({ children }: { children: ReactNode }) {
  const [navOpen, setNavOpen] = useState(false)
  const { path, spaceId, query } = useLocation()
  const mode: RailMode = path === '/solo' ? 'solo' : 'space'
  const qs = query.toString()
  lastHref[mode] = mode === 'solo' ? `/solo${qs ? `?${qs}` : ''}` : `${spaceId ? spacePath(spaceId, path) : path}${qs ? `?${qs}` : ''}`
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
      <Sidebar open={navOpen} onClose={() => setNavOpen(false)} mode={mode} />
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
