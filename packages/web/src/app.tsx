import { DataProvider } from './api'
import { AppShell } from './components/layout'
import { Skeleton, Toaster } from './components/ui'
import { matchPath, useLocation } from './lib/router'
import { useTheme } from './lib/theme'
import { AttentionPage } from './pages/attention'
import { OverviewPage } from './pages/overview'
import { NotFoundPage, PlaceholderPage } from './pages/placeholder'
import { RequirementPage } from './pages/requirement'
import { RequirementsPage } from './pages/requirements'
import { RunPage } from './pages/run'

function Routes() {
  const { path } = useLocation()
  if (path === '/' || path === '') return <OverviewPage />
  if (path === '/requirements') return <RequirementsPage />
  if (path === '/attention') return <AttentionPage />
  if (path === '/knowledge') return <PlaceholderPage kind="knowledge" />
  if (path === '/settings') return <PlaceholderPage kind="settings" />
  const req = matchPath('/req/:id', path)
  if (req) return <RequirementPage key={req.id} id={req.id!} />
  const run = matchPath('/run/:runId', path)
  if (run) return <RunPage key={run.runId} runId={run.runId!} />
  return <NotFoundPage />
}

function Boot() {
  return (
    <div className="shell">
      <aside className="sidebar">
        <Skeleton w={120} h={18} style={{ margin: '6px 8px 20px' }} />
        {[0, 1, 2, 3, 4].map((i) => (
          <Skeleton key={i} w="80%" h={12} style={{ margin: '10px 8px' }} />
        ))}
      </aside>
      <div className="shell-main">
        <div className="topbar" />
        <main className="shell-content">
          <Skeleton w={220} h={22} />
          <Skeleton w={380} h={12} style={{ marginTop: 10 }} />
        </main>
      </div>
    </div>
  )
}

export function App() {
  useTheme()
  return (
    <DataProvider fallback={<Boot />}>
      <AppShell>
        <Routes />
      </AppShell>
      <Toaster />
    </DataProvider>
  )
}
