import { lazy, Suspense, useEffect, type ReactNode } from 'react'
import { RotateCw } from 'lucide-react'
import { DataProvider } from './api'
import { AppShell, useMissingSpace } from './components/layout'
import { RequirementCreateDialog } from './components/requirement-create'
import { SpaceCreateDialog } from './components/space-create'
import { TaktLoader } from './components/takt'
import { EmptyState, ErrorState, Skeleton, SkeletonGrid, Toaster } from './components/ui'
import { matchPath, useLocation } from './lib/router'
import { useGlobalShortcuts } from './lib/shortcuts'
import './lib/theme'
import { openCreateRequirement, openCreateSpace, openSteward, useStewardDock } from './lib/ui-store'
import { OverviewPage } from './pages/overview'
import { NotFoundPage, SpaceNotFoundPage } from './pages/placeholder'
import { RequirementsPage } from './pages/requirements'

// 按需加载（docs/design/22 §3.5：首屏 JS 增量 ≤ 60KB）：Solo、停靠面板、知识库页
// 总览与需求列表是最常见的首屏，随主包；其余页面按路由分包（画布、运行详情、评测、设置各自较重），首屏渲染后空闲时预取
const PAGES = {
  attention: () => import('./pages/attention'),
  eval: () => import('./pages/eval'),
  requirement: () => import('./pages/requirement'),
  run: () => import('./pages/run'),
  settings: () => import('./pages/settings'),
  spaces: () => import('./pages/spaces'),
  workflow: () => import('./pages/workflow'),
  workflowsList: () => import('./pages/workflows-list'),
  solo: () => import('./pages/solo'),
  knowledge: () => import('./pages/knowledge'),
  knowledgeDetail: () => import('./pages/knowledge/detail'),
  uiGallery: () => import('./pages/ui-gallery'),
  automations: () => import('./pages/automations'),
}
const AttentionPage = lazy(() => PAGES.attention().then((m) => ({ default: m.AttentionPage })))
const EvalPage = lazy(() => PAGES.eval().then((m) => ({ default: m.EvalPage })))
const RequirementPage = lazy(() => PAGES.requirement().then((m) => ({ default: m.RequirementPage })))
const RunPage = lazy(() => PAGES.run().then((m) => ({ default: m.RunPage })))
const SettingsPage = lazy(() => PAGES.settings().then((m) => ({ default: m.SettingsPage })))
const SpacesPage = lazy(() => PAGES.spaces().then((m) => ({ default: m.SpacesPage })))
const WorkflowEditorPage = lazy(() => PAGES.workflow().then((m) => ({ default: m.WorkflowEditorPage })))
const WorkflowsListPage = lazy(() => PAGES.workflowsList().then((m) => ({ default: m.WorkflowsListPage })))
const SoloPage = lazy(() => PAGES.solo().then((m) => ({ default: m.SoloPage })))
const StewardDock = lazy(() => import('./components/steward/dock').then((m) => ({ default: m.StewardDock })))
const KnowledgeListPage = lazy(() => PAGES.knowledge().then((m) => ({ default: m.KnowledgeListPage })))
const KnowledgeDetailPage = lazy(() => PAGES.knowledgeDetail().then((m) => ({ default: m.KnowledgeDetailPage })))
const UiGalleryPage = lazy(() => PAGES.uiGallery().then((m) => ({ default: m.UiGalleryPage })))
const AutomationsPage = lazy(() => PAGES.automations().then((m) => ({ default: m.AutomationsPage })))

/**
 * 首屏之后空闲时把各页面分包预取进缓存，切页时不再等下载；
 * 省流量模式、2G 和手机窄屏不预取，别让首屏流量花在用户可能不去的页面上（TF-064）。
 */
function usePrefetchPages() {
  useEffect(() => {
    const net = (navigator as Navigator & { connection?: { saveData?: boolean; effectiveType?: string } }).connection
    if (net?.saveData || /^(slow-)?2g$/.test(net?.effectiveType ?? '') || window.matchMedia?.('(max-width: 640px)').matches) return
    const idle = window.requestIdleCallback ?? ((f: () => void) => window.setTimeout(f, 1200))
    const cancel = window.cancelIdleCallback ?? window.clearTimeout
    const id = idle(() => Object.values(PAGES).forEach((load) => void load().catch(() => undefined)))
    return () => cancel(id)
  }, [])
}

function Routes() {
  const { path, spaceId } = useLocation()
  const access = useMissingSpace(spaceId)
  const missing = access.data
  const local = path !== '/spaces' && path !== '/solo'
  if (spaceId && local && access.loading && access.data === undefined) return <RouteFallback />
  if (spaceId && local && access.error) return <ErrorState error={access.error} onRetry={access.reload} />
  // 地址里的空间不存在 / 已归档：空间内页面都换成说明页（全局页照常，"全部空间"就是出口）
  if (missing && local) return <SpaceNotFoundPage key={spaceId} id={spaceId!} archived={missing.archived} />
  return <SpaceRoutes key={spaceId ?? ''} path={path} />
}

function SpaceRoutes({ path }: { path: string }) {
  if (path === '/' || path === '') return <OverviewPage />
  // 全局路由：带不带 /s/:space 前缀都能访问
  if (path === '/solo') return <SoloPage />
  if (path === '/spaces') return <SpacesPage />
  if (path === '/requirements') return <RequirementsPage />
  if (path === '/attention') return <AttentionPage />
  if (path === '/knowledge') return <KnowledgeListPage />
  if (path === '/settings') return <SettingsPage />
  if (path === '/workflows') return <WorkflowsListPage />
  if (path === '/eval') return <EvalPage />
  if (path === '/automations') return <AutomationsPage />
  // 组件陈列（docs/design/30 §1）：不进导航，⌘K 搜"组件"可达
  if (path === '/ui') return <UiGalleryPage />
  const kb = matchPath('/knowledge/:id', path)
  if (kb) return <KnowledgeDetailPage key={kb.id} id={kb.id!} />
  const req = matchPath('/req/:id', path)
  if (req) return <RequirementPage key={req.id} id={req.id!} />
  const wf = matchPath('/workflows/:id', path)
  if (wf) return <WorkflowEditorPage key={wf.id} id={wf.id!} />
  const run = matchPath('/run/:runId', path)
  if (run) return <RunPage key={run.runId} runId={run.runId!} />
  return <NotFoundPage />
}

/** 按需加载的页面还没到：页头 + 卡片网格的骨架（120ms 后才显示）。 */
function RouteFallback() {
  return (
    <div className="page" aria-busy="true">
      <Skeleton w={180} h={22} style={{ marginBottom: 10 }} />
      <Skeleton w={360} h={12} style={{ marginBottom: 32 }} />
      <SkeletonGrid count={4} />
    </div>
  )
}

/** 停靠面板第一次打开时才加载；管家整页本身就是对话，不再叠一个面板（"问管家"落到整页的输入框，见 SoloPage）。 */
function DockMount() {
  const dock = useStewardDock()
  const { path } = useLocation()
  if (path === '/solo' || (!dock.open && dock.nonce === 0)) return null
  return (
    <Suspense fallback={null}>
      <StewardDock />
    </Suspense>
  )
}

/** 调试 / 截图开关：?open=steward[&ask=问题&thread=id] | create-requirement[&title=&desc=] | create-space[&copyFrom=]，首屏打开对应浮层。 */
function useOpenParam() {
  useEffect(() => {
    const q = new URLSearchParams(location.search)
    const open = q.get('open')
    if (open === 'steward') openSteward({ prefill: q.get('ask') ?? undefined, threadId: q.get('thread') ?? undefined })
    else if (open === 'create-requirement') {
      const title = q.get('title') ?? undefined
      const description = q.get('desc') ?? undefined
      openCreateRequirement(title || description ? { title, description } : undefined)
    }
    else if (open === 'create-space') openCreateSpace({ copyFrom: q.get('copyFrom') ?? undefined })
  }, [])
}

function GlobalMounts() {
  useGlobalShortcuts()
  useOpenParam()
  usePrefetchPages()
  return (
    <>
      <DockMount />
      <RequirementCreateDialog />
      <SpaceCreateDialog />
    </>
  )
}

/** 首屏：导轨先占位，工作区放节拍加载；服务慢、正在退避重试时说清楚。 */
function Boot({ children }: { children: ReactNode }) {
  return (
    <div className="shell">
      <aside className="sidebar" aria-hidden />
      <div className="shell-main">
        <div className="topbar" />
        <main className="shell-content">{children}</main>
      </div>
    </div>
  )
}

/** 重试用尽仍连不上：明确报错并给重试，不静默换成演示数据（演示数据只作为一个显式的去处）。 */
function ConnectFailed({ retry }: { retry: () => void }) {
  const demo = new URL(location.href)
  demo.searchParams.set('mock', '1')
  return (
    <Boot>
      <div role="alert" className="card" style={{ maxWidth: 640, margin: '40px auto' }}>
        <EmptyState
          mascot="ask"
          title="连不上 takt serve"
          body="等了十几秒仍没有响应：服务可能没启动、已经退出，或者正忙。确认服务在运行后点重试。"
          action={
            <>
              <button type="button" className="btn btn-primary" onClick={retry}>
                <RotateCw aria-hidden />
                重试
              </button>
              <a className="btn" href={demo.pathname + demo.search}>
                看演示数据（只读）
              </a>
            </>
          }
        />
      </div>
    </Boot>
  )
}

export function App() {
  return (
    <DataProvider
      fallback={(attempt) => (
        <Boot>
          <TaktLoader label={attempt ? `服务响应较慢，正在重试（第 ${attempt} 次）` : '正在连接 taktflow'} />
        </Boot>
      )}
      failed={(retry) => <ConnectFailed retry={retry} />}
    >
      <AppShell>
        <Suspense fallback={<RouteFallback />}>
          <Routes />
        </Suspense>
      </AppShell>
      <GlobalMounts />
      <Toaster />
    </DataProvider>
  )
}
