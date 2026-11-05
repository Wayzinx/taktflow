import { useEffect, useState, useSyncExternalStore } from 'react'

export type ThemePref = 'system' | 'light' | 'dark'

/**
 * 主题来源。独立页面自己管理（写 documentElement 的 data-theme）；嵌入宿主时由宿主提供，
 * 本模块不写任何全局属性，嵌入根节点按 isDark 自己挂 data-theme。
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

/** 是否由宿主管理主题（嵌入模式下不显示主题切换）。 */
export function themeIsHosted(): boolean {
  return host !== undefined
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
  if (host) return
  if (pref === 'system') document.documentElement.removeAttribute('data-theme')
  else document.documentElement.setAttribute('data-theme', pref)
}

/** 独立页面的主题偏好；嵌入模式下返回 system 且修改无效。 */
export function useTheme(): [ThemePref, (p: ThemePref) => void] {
  const [pref, setPref] = useState<ThemePref>(() => (host ? 'system' : readPref()))
  useEffect(() => apply(pref), [pref])
  const update = (p: ThemePref) => {
    if (host) return
    try {
      if (p === 'system') localStorage.removeItem(KEY)
      else localStorage.setItem(KEY, p)
    } catch {
      // 同上
    }
    setPref(p)
  }
  return [pref, update]
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
