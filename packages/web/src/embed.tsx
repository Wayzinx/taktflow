import { useLayoutEffect, useState } from 'react'
import { DataProvider, type DataSource } from './api'
import { Routes } from './app'
import { AppShell } from './components/layout'
import { Skeleton, Toaster } from './components/ui'
import { createMemoryRouter, setRouter } from './lib/router'
import { setThemeHost, useIsDark, type ThemeHost } from './lib/theme'
import './styles/tokens.css'
import './styles/base.css'
import './styles/embed.css'

export type { DataSource, NodeView } from './api'
export { ApiRequestError } from './api/client'
export type { ThemeHost } from './lib/theme'

export interface TaktflowEmbedProps {
  /** 必填：嵌入模式不回退到演示数据，接口失败就显示错误。 */
  source: DataSource
  /** 宿主主题；深浅色切换时回调。 */
  theme: ThemeHost
  /** 初始页面，例如 `/req/REQ-1`；默认总览。 */
  initialPath?: string
}

function Root() {
  const dark = useIsDark()
  return (
    <div className="takt-root" data-embedded="" data-theme={dark ? 'dark' : 'light'}>
      <AppShell variant="embedded">
        <Routes />
      </AppShell>
      <Toaster />
    </div>
  )
}

/**
 * 嵌入宿主（dsh 主面板）用的根组件。路由在内存里、主题跟随宿主、数据源由宿主注入；
 * 不写 history、documentElement 和 body。同一时刻只支持挂载一个实例。
 */
export function TaktflowEmbed({ source, theme, initialPath = '/' }: TaktflowEmbedProps) {
  const [ready, setReady] = useState(false)
  // 路由和主题要在子组件第一次读取之前就位
  useLayoutEffect(() => {
    const restoreRouter = setRouter(createMemoryRouter(initialPath))
    const restoreTheme = setThemeHost(theme)
    setReady(true)
    return () => {
      restoreTheme()
      restoreRouter()
    }
  }, [initialPath, theme])
  if (!ready) return null
  return (
    <DataProvider source={source} fallback={<Skeleton w={220} h={22} />}>
      <Root />
    </DataProvider>
  )
}
