import { useEffect, useState, useSyncExternalStore } from 'react'

export type ThemePref = 'system' | 'light' | 'dark'

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
let current: ThemePref = readPref()
const subs = new Set<() => void>()
apply(current)

export function setTheme(p: ThemePref) {
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

/** 当前实际生效的是不是深色（画布等需要显式传 colorMode 的组件用）。 */
export function useIsDark(): boolean {
  const get = () => {
    const attr = document.documentElement.getAttribute('data-theme')
    if (attr) return attr === 'dark'
    return window.matchMedia('(prefers-color-scheme: dark)').matches
  }
  const [dark, setDark] = useState(get)
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const update = () => setDark(get())
    const obs = new MutationObserver(update)
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    mq.addEventListener('change', update)
    return () => {
      obs.disconnect()
      mq.removeEventListener('change', update)
    }
  }, [])
  return dark
}
