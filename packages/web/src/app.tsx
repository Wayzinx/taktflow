import { DataProvider } from './api'
import { pickSource } from './api/pick'
import { AppShell } from './components/layout'
import { TaktLoader } from './components/takt'
import { Toaster } from './components/ui'
import { initTheme } from './lib/theme'
import { Routes } from './routes'

initTheme()

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
    <DataProvider source={pickSource} fallback={<Boot />}>
      <AppShell>
        <Routes />
      </AppShell>
      <Toaster />
    </DataProvider>
  )
}
