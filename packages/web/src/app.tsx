import { lazy, Suspense, useEffect } from 'react'
import { DataProvider } from './api'
import { AppShell } from './components/layout'
import { RequirementCreateDialog } from './components/requirement-create'
import { SpaceCreateDialog } from './components/space-create'
import { TaktLoader } from './components/takt'
import { Skeleton, SkeletonGrid, Toaster } from './components/ui'
import { matchPath, navigate, useLocation } from './lib/router'
import { useGlobalShortcuts } from './lib/shortcuts'
import './lib/theme'
import { openCreateRequirement, openCreateSpace, openSteward, useStewardDock } from './lib/ui-store'
import { OverviewPage } from './pages/overview'
import { NotFoundPage } from './pages/placeholder'
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

/** 首屏之后空闲时把各页面分包预取进缓存，切页时不再等下载。 */
function usePrefetchPages() {
  useEffect(() => {
    const idle = window.requestIdleCallback ?? ((f: () => void) => window.setTimeout(f, 1200))
    const cancel = window.cancelIdleCallback ?? window.clearTimeout
    const id = idle(() => Object.values(PAGES).forEach((load) => void load().catch(() => undefined)))
    return () => cancel(id)
  }, [])
}

function Routes() {
  const { path, spaceId } = useLocation()
  return <SpaceRoutes key={spaceId ?? ''} path={path} />
}

function SpaceRoutes({ path }: { path: string }) {
  if (path === '/' || path === '') return <OverviewPage />
  // 全局路由：带不带 /s/:space 前缀都能访问
  if (path === '/solo') return <SoloPage />
  // 原管家整页并入 Solo（docs/design/28）：旧地址带着查询参数跳过去
  if (path === '/steward') return <Redirect to={`/solo${location.search}`} />
  if (path === '/spaces') return <SpacesPage />
  if (path === '/requirements') return <RequirementsPage />
  if (path === '/attention') return <AttentionPage />
  if (path === '/knowledge') return <KnowledgeListPage />
  if (path === '/settings') return <SettingsPage />
  if (path === '/workflows') return <WorkflowsListPage />
  if (path === '/eval') return <EvalPage />
  // 组件陈列（docs/design/30 §1）：不进导航，⌘K 搜"组件"可达
  if (path === '/ui') return <UiGalleryPage />
  // /settings/:tab 是 /settings?tab= 的别名（members / repos / skills / agents / workflows / knowledge / runtime）
  const st = matchPath('/settings/:tab', path)
  if (st) return <Redirect to={`/settings?tab=${encodeURIComponent(st.tab!)}`} />
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

function Redirect({ to }: { to: string }) {
  useEffect(() => navigate(to, { replace: true }), [to])
  return null
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

/** 停靠面板第一次打开时才加载。 */
function DockMount() {
  const dock = useStewardDock()
  if (!dock.open && dock.nonce === 0) return null
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

/** 首屏：导轨先占位，工作区放节拍加载。 */
function Boot() {
  return (
    <div className="shell">
      <aside className="sidebar" aria-hidden />
      <div className="shell-main">
        <div className="topbar" />
        <main className="shell-content">
          <TaktLoader label="正在连接 taktflow" />
        </main>
      </div>
    </div>
  )
}

export function App() {
  return (
    <DataProvider fallback={<Boot />}>
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
