import { useSyncExternalStore, type AnchorHTMLAttributes, type MouseEvent } from 'react'
import { splitSpace, spacePath } from './space'

/**
 * 极简路由：history.pushState + useSyncExternalStore。mock / theme 两个全局查询参数在跳转时自动保留。
 * 当前 URL 带空间前缀（/s/:spaceId）时，站内绝对路径自动补上同一个前缀，页面里照常写 /req/xxx。
 */

const listeners = new Set<() => void>()
const notify = () => listeners.forEach((l) => l())
window.addEventListener('popstate', notify)

const STICKY = ['mock', 'theme']

function withSticky(to: string): string {
  const url = new URL(to, location.origin)
  const { spaceId } = splitSpace(location.pathname)
  if (spaceId && !url.pathname.startsWith('/s/')) url.pathname = spacePath(spaceId, url.pathname)
  const current = new URLSearchParams(location.search)
  for (const key of STICKY) {
    const v = current.get(key)
    if (v !== null && !url.searchParams.has(key)) url.searchParams.set(key, v)
  }
  return url.pathname + url.search + url.hash
}

export function href(to: string): string {
  return withSticky(to)
}

export function navigate(to: string, opts: { replace?: boolean } = {}) {
  const target = withSticky(to)
  if (target === location.pathname + location.search) return
  history[opts.replace ? 'replaceState' : 'pushState'](null, '', target)
  notify()
  if (!opts.replace) window.scrollTo({ top: 0 })
}

/** 只改查询参数（Tab、选中的节点等），默认 replace，不产生历史记录。 */
export function setQuery(patch: Record<string, string | undefined>, opts: { replace?: boolean } = { replace: true }) {
  const params = new URLSearchParams(location.search)
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined || v === '') params.delete(k)
    else params.set(k, v)
  }
  const qs = params.toString()
  const target = location.pathname + (qs ? `?${qs}` : '')
  history[opts.replace === false ? 'pushState' : 'replaceState'](null, '', target)
  notify()
}

const subscribe = (cb: () => void) => {
  listeners.add(cb)
  return () => listeners.delete(cb)
}
const snapshot = () => location.pathname + location.search

/** path 是去掉空间前缀后的站内路径；spaceId 为 undefined 表示默认空间。 */
export function useLocation(): { path: string; query: URLSearchParams; spaceId?: string } {
  const s = useSyncExternalStore(subscribe, snapshot)
  const i = s.indexOf('?')
  const { spaceId, rest } = splitSpace(i < 0 ? s : s.slice(0, i))
  return { path: rest, spaceId, query: new URLSearchParams(i < 0 ? '' : s.slice(i)) }
}

export function matchPath(pattern: string, path: string): Record<string, string> | null {
  const p = pattern.split('/').filter(Boolean)
  const s = path.split('/').filter(Boolean)
  if (p.length !== s.length) return null
  const params: Record<string, string> = {}
  for (let i = 0; i < p.length; i++) {
    const seg = p[i]!
    if (seg.startsWith(':')) params[seg.slice(1)] = decodeURIComponent(s[i]!)
    else if (seg !== s[i]) return null
  }
  return params
}

export function Link({ to, onClick, ...rest }: AnchorHTMLAttributes<HTMLAnchorElement> & { to: string }) {
  const handle = (e: MouseEvent<HTMLAnchorElement>) => {
    onClick?.(e)
    if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return
    e.preventDefault()
    navigate(to)
  }
  return <a href={href(to)} onClick={handle} {...rest} />
}
