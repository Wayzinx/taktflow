import { useSyncExternalStore, type AnchorHTMLAttributes, type MouseEvent } from 'react'
import { splitSpace, spacePath } from './space'

/**
 * 极简路由：当前位置是 "path?query" 字符串，保存在可替换的适配器里。
 * - 独立页面用浏览器适配器（history.pushState）：mock / theme 两个全局查询参数在跳转时自动保留；
 *   当前 URL 带空间前缀（/s/:spaceId）时，站内绝对路径自动补上同一个前缀，页面里照常写 /req/xxx。
 * - 嵌入宿主时用内存适配器，不碰 history 和 window 事件。
 */
export interface RouterAdapter {
  /** 当前位置，形如 `/req/REQ-1?tab=runs`。 */
  read(): string
  write(target: string, opts: { replace: boolean }): void
  /** 外部变化（浏览器前进后退）时回调；返回取消订阅。 */
  listen(cb: () => void): () => void
  /** 规范化跳转目标（补空间前缀、保留全局参数）；也用作 `<a href>`。 */
  resolve(to: string): string
}

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

export function createBrowserRouter(): RouterAdapter {
  return {
    read: () => location.pathname + location.search,
    write(target, { replace }) {
      history[replace ? 'replaceState' : 'pushState'](null, '', target)
      if (!replace) window.scrollTo({ top: 0 })
    },
    listen(cb) {
      window.addEventListener('popstate', cb)
      return () => window.removeEventListener('popstate', cb)
    },
    resolve: withSticky,
  }
}

export function createMemoryRouter(initial = '/'): RouterAdapter {
  let current = initial
  return {
    read: () => current,
    write(target) {
      current = target
    },
    listen: () => () => {},
    resolve: (to) => to,
  }
}

let adapter: RouterAdapter | undefined
const listeners = new Set<() => void>()
let unlisten: (() => void) | undefined
const notify = () => listeners.forEach((l) => l())

function active(): RouterAdapter {
  adapter ??= createBrowserRouter()
  return adapter
}

/** 嵌入方在挂载前调用；返回恢复函数。同一时刻只支持一个路由实例。 */
export function setRouter(next: RouterAdapter): () => void {
  const prev = adapter
  unlisten?.()
  adapter = next
  unlisten = listeners.size ? next.listen(notify) : undefined
  notify()
  return () => {
    if (adapter !== next) return
    unlisten?.()
    adapter = prev
    unlisten = prev && listeners.size ? prev.listen(notify) : undefined
  }
}

/** 当前位置（"path?query"，含空间前缀）；给非组件代码用，例如 currentSpaceId。 */
export function currentLocation(): string {
  return active().read()
}

export function href(to: string): string {
  return active().resolve(to)
}

export function navigate(to: string, opts: { replace?: boolean } = {}) {
  const router = active()
  const target = router.resolve(to)
  if (target === router.read()) return
  router.write(target, { replace: opts.replace ?? false })
  notify()
}

/** 只改查询参数（Tab、选中的节点等），默认 replace，不产生历史记录。 */
export function setQuery(patch: Record<string, string | undefined>, opts: { replace?: boolean } = { replace: true }) {
  const router = active()
  const loc = router.read()
  const i = loc.indexOf('?')
  const params = new URLSearchParams(i < 0 ? '' : loc.slice(i))
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined || v === '') params.delete(k)
    else params.set(k, v)
  }
  const qs = params.toString()
  router.write((i < 0 ? loc : loc.slice(0, i)) + (qs ? `?${qs}` : ''), { replace: opts.replace !== false })
  notify()
}

// 第一个订阅者出现时才挂外部监听，最后一个离开时撤掉：模块加载没有副作用。
const subscribe = (cb: () => void) => {
  if (listeners.size === 0) unlisten = active().listen(notify)
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
    if (listeners.size === 0) {
      unlisten?.()
      unlisten = undefined
    }
  }
}
const snapshot = () => active().read()

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
