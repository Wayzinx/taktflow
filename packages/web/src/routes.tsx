import { matchPath, useLocation } from './lib/router'
import { AttentionPage } from './pages/attention'
import { OverviewPage } from './pages/overview'
import { NotFoundPage, PlaceholderPage } from './pages/placeholder'
import { RequirementPage } from './pages/requirement'
import { RequirementsPage } from './pages/requirements'
import { RunPage } from './pages/run'
import { SettingsPage } from './pages/settings'

/** 页面路由表；独立页面（app.tsx）和嵌入入口（embed.tsx）共用。 */
export function Routes() {
  const { path } = useLocation()
  if (path === '/' || path === '') return <OverviewPage />
  if (path === '/requirements') return <RequirementsPage />
  if (path === '/attention') return <AttentionPage />
  if (path === '/knowledge') return <PlaceholderPage kind="knowledge" />
  if (path === '/settings') return <SettingsPage />
  const req = matchPath('/req/:id', path)
  if (req) return <RequirementPage key={req.id} id={req.id!} />
  const run = matchPath('/run/:runId', path)
  if (run) return <RunPage key={run.runId} runId={run.runId!} />
  return <NotFoundPage />
}
