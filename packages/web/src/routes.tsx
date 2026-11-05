import { useEffect } from 'react'
import { matchPath, navigate, useLocation } from './lib/router'
import { AttentionPage } from './pages/attention'
import { EvalPage } from './pages/eval'
import { OverviewPage } from './pages/overview'
import { NotFoundPage } from './pages/placeholder'
import { RequirementPage } from './pages/requirement'
import { RequirementsPage } from './pages/requirements'
import { RunPage } from './pages/run'
import { SettingsPage } from './pages/settings'
import { WorkflowEditorPage } from './pages/workflow'
import { WorkflowsListPage } from './pages/workflows-list'

/** 页面路由表；独立页面（app.tsx）和嵌入入口（embed.tsx）共用。 */
export function Routes() {
  const { path, spaceId } = useLocation()
  return <SpaceRoutes key={spaceId ?? ''} path={path} />
}

function SpaceRoutes({ path }: { path: string }) {
  if (path === '/' || path === '') return <OverviewPage />
  if (path === '/requirements') return <RequirementsPage />
  if (path === '/attention') return <AttentionPage />
  if (path === '/knowledge') return <Redirect to="/settings?tab=knowledge" />
  if (path === '/settings') return <SettingsPage />
  if (path === '/workflows') return <WorkflowsListPage />
  if (path === '/eval') return <EvalPage />
  // /settings/:tab 是 /settings?tab= 的别名（members / repos / skills / agents / workflows / knowledge / runtime）
  const st = matchPath('/settings/:tab', path)
  if (st) return <Redirect to={`/settings?tab=${encodeURIComponent(st.tab!)}`} />
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
