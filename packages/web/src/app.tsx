import { DataProvider } from './api'
import { AppShell } from './components/layout'
import { TaktLoader } from './components/takt'
import { Toaster } from './components/ui'
import { matchPath, useLocation } from './lib/router'
import './lib/theme'
import { AttentionPage } from './pages/attention'
import { OverviewPage } from './pages/overview'
import { NotFoundPage, PlaceholderPage } from './pages/placeholder'
import { RequirementPage } from './pages/requirement'
import { RequirementsPage } from './pages/requirements'
import { RunPage } from './pages/run'
import { SettingsPage } from './pages/settings'

function Routes() {
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
        <Routes />
      </AppShell>
      <Toaster />
    </DataProvider>
  )
}
