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
import { AttentionPage } from './pages/attention'
import { EvalPage } from './pages/eval'
import { OverviewPage } from './pages/overview'
import { NotFoundPage } from './pages/placeholder'
import { RequirementPage } from './pages/requirement'
import { RequirementsPage } from './pages/requirements'
import { RunPage } from './pages/run'
import { SettingsPage } from './pages/settings'
import { SpacesPage } from './pages/spaces'
import { WorkflowEditorPage } from './pages/workflow'
import { WorkflowsListPage } from './pages/workflows-list'

// 按需加载（docs/design/22 §3.5：首屏 JS 增量 ≤ 60KB）：管家整页、停靠面板、知识库页
const StewardPage = lazy(() => import('./pages/steward').then((m) => ({ default: m.StewardPage })))
const StewardDock = lazy(() => import('./components/steward/dock').then((m) => ({ default: m.StewardDock })))
const KnowledgeListPage = lazy(() => import('./pages/knowledge').then((m) => ({ default: m.KnowledgeListPage })))
const KnowledgeDetailPage = lazy(() => import('./pages/knowledge/detail').then((m) => ({ default: m.KnowledgeDetailPage })))

function Routes() {
  const { path, spaceId } = useLocation()
  return <SpaceRoutes key={spaceId ?? ''} path={path} />
}

function SpaceRoutes({ path }: { path: string }) {
  if (path === '/' || path === '') return <OverviewPage />
  // 全局路由：带不带 /s/:space 前缀都能访问
  if (path === '/steward') return <StewardPage />
  if (path === '/spaces') return <SpacesPage />
  if (path === '/requirements') return <RequirementsPage />
  if (path === '/attention') return <AttentionPage />
  if (path === '/knowledge') return <KnowledgeListPage />
  if (path === '/settings') return <SettingsPage />
  if (path === '/workflows') return <WorkflowsListPage />
  if (path === '/eval') return <EvalPage />
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
