import { createContext, useContext, useSyncExternalStore, type AnchorHTMLAttributes, type MouseEvent } from 'react'
import { flushSync } from 'react-dom'
import { splitSpace, spacePath } from './space'

/**
 * 极简路由：history.pushState + useSyncExternalStore。mock / theme 两个全局查询参数在跳转时自动保留。
 * 当前 URL 带空间前缀（/s/:spaceId）时，站内绝对路径自动补上同一个前缀，页面里照常写 /req/xxx。
 */

const listeners = new Set<() => void>()
const notify = () => listeners.forEach((l) => l())

/**
 * 路由转场（M4 体验基线 3）：路径变化时用 View Transitions 包住渲染（flushSync 保证回调里 DOM 已更新），
 * 样式见 styles/motion.css 的 ::view-transition-*(page)。不支持的浏览器由 <PageTransition> 播入场动画。
 */
type StartVT = (cb: () => void) => unknown
export function viewTransitionsEnabled(): boolean {
  return typeof document !== 'undefined' && typeof (document as unknown as { startViewTransition?: StartVT }).startViewTransition === 'function'
}
let lastPath = location.pathname
function notifyRoute() {
  const changed = location.pathname !== lastPath
  lastPath = location.pathname
  if (changed && viewTransitionsEnabled() && !document.hidden) {
    const start = (document as unknown as { startViewTransition: StartVT }).startViewTransition.bind(document)
    start(() => flushSync(notify))
    return
  }
  notify()
}
// reduced-motion 下仍然走 View Transitions：motion.css 把它改成纯淡入淡出
window.addEventListener('popstate', notifyRoute)

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
  notifyRoute()
  if (!opts.replace) scrollToTop()
}

/** 工作区面板自己滚动（docs/design/29）；没有外壳时（测试、独立页）退回窗口。 */
export function scrollToTop() {
  const panel = document.querySelector('.shell-main')
  if (panel) panel.scrollTo({ top: 0 })
  else window.scrollTo({ top: 0 })
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
  lastPath = location.pathname
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

/** 子树里的页内路径属于哪个空间（api 的 SpaceScope 设置）：全局页（Solo）里展示别的空间的对象时，链接要指向那个空间。 */
const LinkSpace = createContext<string | undefined>(undefined)
export const LinkSpaceProvider = LinkSpace.Provider

/** 页内路径 → 带空间前缀的路径：在 SpaceScope 里用绑定的空间，否则交给 href / navigate 按当前地址补。 */
export function useSpaceHref(): (to: string) => string {
  const space = useContext(LinkSpace)
  return (to) => (space && to.startsWith('/') && !to.startsWith('/s/') ? spacePath(space, to) : to)
}

export function Link({ to, onClick, ...rest }: AnchorHTMLAttributes<HTMLAnchorElement> & { to: string }) {
  const target = useSpaceHref()(to)
  const handle = (e: MouseEvent<HTMLAnchorElement>) => {
    onClick?.(e)
    if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return
    e.preventDefault()
    navigate(target)
  }
  return <a href={href(target)} onClick={handle} {...rest} />
}
