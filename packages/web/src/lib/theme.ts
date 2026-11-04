import { useEffect, useState } from 'react'

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

export function useTheme(): [ThemePref, (p: ThemePref) => void] {
  const [pref, setPref] = useState<ThemePref>(readPref)
  useEffect(() => apply(pref), [pref])
  const update = (p: ThemePref) => {
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
