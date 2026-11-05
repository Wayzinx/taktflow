import { DataProvider } from './api'
import { pickSource } from './api/pick'
import { AppShell } from './components/layout'
import { Skeleton, Toaster } from './components/ui'
import { useTheme } from './lib/theme'
import { Routes } from './routes'

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
    <DataProvider source={pickSource} fallback={<Boot />}>
      <AppShell>
        <Routes />
      </AppShell>
      <Toaster />
    </DataProvider>
  )
}
