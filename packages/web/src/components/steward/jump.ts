import { navigate } from '../../lib/router'
import { prefersReducedMotion } from '../../lib/motion'

/**
 * 引用 / 证据跳转（docs/design/22 §1.3）：跳到站内路由，再在目标页里找到对应的元素滚动过去并 .jump-highlight。
 * 目标优先级：[data-steward-anchor~=token] → id=hash → 正文里文字包含 token 的行 / 卡片 / 条目；找不到就只跳转。
 * token 从链接和标签里取：REQ-001、run-…、?node=xxx、#xxx。
 */
const ID_RE = /\b(REQ-\d+|run-[\w-]+)\b/g

export function anchorTokens(href: string, label?: string): string[] {
  const url = new URL(href, location.origin)
  const out = new Set<string>()
  const node = url.searchParams.get('node')
  if (node) out.add(node)
  if (url.hash.length > 1) out.add(decodeURIComponent(url.hash.slice(1)).replace(/^node=/, ''))
  for (const m of `${label ?? ''} ${url.pathname}`.matchAll(ID_RE)) out.add(m[1]!)
  return [...out]
}

const ROW_SEL = '[data-steward-anchor], tr, li, [role="row"], article, .card, .attention-card'

function findTarget(tokens: string[]): HTMLElement | null {
  const root = document.getElementById('main') ?? document.body
  for (const t of tokens) {
    const byAnchor = root.querySelector<HTMLElement>(`[data-steward-anchor~="${CSS.escape(t)}"]`)
    if (byAnchor) return byAnchor
    const byId = document.getElementById(t)
    if (byId && root.contains(byId)) return byId
  }
  // 文字匹配：最内层的行 / 卡片
  const rows = [...root.querySelectorAll<HTMLElement>(ROW_SEL)]
  for (const t of tokens) {
    const hits = rows.filter((el) => el.textContent?.includes(t))
    if (hits.length) return hits.reduce((a, b) => (a.contains(b) ? b : a))
  }
  return null
}

export function highlight(el: HTMLElement) {
  el.classList.remove('jump-highlight')
  // 强制重排，重复点同一条也能重播
  void el.offsetWidth
  el.classList.add('jump-highlight')
  el.scrollIntoView({ block: 'center', behavior: prefersReducedMotion() ? 'auto' : 'smooth' })
  setTimeout(() => el.classList.remove('jump-highlight'), 2500)
}

let pending = 0
/** 不跳转，只在当前页里等目标出现后滚过去并高亮（最多 2 秒）。 */
export function focusAnchor(tokens: string[], delay = 0) {
  const id = ++pending
  const started = Date.now()
  const poll = () => {
    if (id !== pending) return
    const el = findTarget(tokens)
    if (el) return highlight(el)
    if (Date.now() - started < 2000) setTimeout(poll, 120)
  }
  setTimeout(poll, delay)
}

export function jumpTo(href: string, label?: string) {
  const tokens = anchorTokens(href, label)
  const sameUrl = new URL(href, location.origin)
  const here = location.pathname === sameUrl.pathname || location.pathname.endsWith(sameUrl.pathname)
  navigate(href)
  // 目标页按需加载 / 拉数据：最多等 2 秒
  if (tokens.length) focusAnchor(tokens, here ? 0 : 260)
}
