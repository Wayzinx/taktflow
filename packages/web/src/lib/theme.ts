import { useSyncExternalStore } from 'react'

export type ThemePref = 'system' | 'light' | 'dark'

/**
 * 主题来源。独立页面自己管理（写 documentElement 的 data-theme，见 initTheme）；
 * 嵌入宿主时由宿主提供，本模块不写任何全局属性，嵌入根节点按 isDark 自己挂 data-theme。
 */
export interface ThemeHost {
  isDark(): boolean
  subscribe(cb: () => void): () => void
}

let host: ThemeHost | undefined

/** 嵌入方在挂载前调用；返回恢复函数。 */
export function setThemeHost(next: ThemeHost): () => void {
  const prev = host
  host = next
  return () => {
    if (host === next) host = prev
  }
}

const KEY = 'takt.theme'

function readPref(): ThemePref {
  const q = new URLSearchParams(location.search).get('theme')
  if (q === 'dark' || q === 'light') return q
  try {
    const v = localStorage.getItem(KEY)
    if (v === 'dark' || v === 'light') return v
  } catch {
    // 隐私模式下 localStorage 可能不可用，按系统主题处理
  }
  return 'system'
}

function apply(pref: ThemePref) {
  if (pref === 'system') document.documentElement.removeAttribute('data-theme')
  else document.documentElement.setAttribute('data-theme', pref)
}

// 全局只有一份主题偏好：侧栏开关、命令面板、首帧脚本读写同一处
let current: ThemePref = 'system'
const subs = new Set<() => void>()

/** 独立页面启动时调用一次：读偏好并写到 documentElement。嵌入模式不调用。 */
export function initTheme() {
  current = readPref()
  apply(current)
}

export function setTheme(p: ThemePref) {
  if (host) return
  try {
    if (p === 'system') localStorage.removeItem(KEY)
    else localStorage.setItem(KEY, p)
  } catch {
    // 同上
  }
  // URL 里的 ?theme= 优先级最高，手动切换后去掉它，否则刷新又变回去
  const params = new URLSearchParams(location.search)
  if (params.has('theme')) {
    params.delete('theme')
    const qs = params.toString()
    history.replaceState(null, '', location.pathname + (qs ? `?${qs}` : ''))
  }
  current = p
  apply(p)
  subs.forEach((f) => f())
}

export function useTheme(): [ThemePref, (p: ThemePref) => void] {
  const pref = useSyncExternalStore(
    (f) => {
      subs.add(f)
      return () => subs.delete(f)
    },
    () => current,
  )
  return [pref, setTheme]
}

function documentIsDark(): boolean {
  const attr = document.documentElement.getAttribute('data-theme')
  if (attr) return attr === 'dark'
  return window.matchMedia('(prefers-color-scheme: dark)').matches
}

function subscribeDocument(cb: () => void): () => void {
  const mq = window.matchMedia('(prefers-color-scheme: dark)')
  const obs = new MutationObserver(cb)
  obs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
  mq.addEventListener('change', cb)
  return () => {
    obs.disconnect()
    mq.removeEventListener('change', cb)
  }
}

/** 当前实际生效的是不是深色（画布等需要显式传 colorMode 的组件用）。 */
export function useIsDark(): boolean {
  return useSyncExternalStore(
    (cb) => (host ? host.subscribe(cb) : subscribeDocument(cb)),
    () => (host ? host.isDark() : documentIsDark()),
  )
}
