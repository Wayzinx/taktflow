import { Fragment, useCallback, useRef, useState, type ReactNode } from 'react'
import { ArrowUpRight, BookOpen, CircleAlert, Copy, FileText, FolderKanban, Inbox, ListChecks, PlayCircle, Radio, Workflow, type LucideIcon } from 'lucide-react'
import type { StewardCitation } from '@taktflow/core'
import { Popover, toast } from '../ui'
import { CodeBlock, Markdown } from '../../lib/markdown'
import { jumpTo } from './jump'
import { filePagePath, fileFocusOf, useEntityFocus } from './focus'
import { href as routeHref, useLocation } from '../../lib/router'
import { spacePath } from '../../lib/space'

type LinkOpener = (href: string, label?: string) => { href: string; go: () => void }

/** /api/ 开头的是服务端地址（如打开运行成品的预览），不是页面路由：新标签页打开。 */
const isServerHref = (href: string) => href.startsWith('/api/')

/** 点站内链接 / 引用：指向需求里的产物时，Solo 在右侧面板打开、别处去需求的产物页；服务端地址新开标签页；其余照常跳转并高亮。 */
function useLinkOpener(): LinkOpener {
  const focus = useEntityFocus()
  const { spaceId } = useLocation()
  return useCallback((href: string, label?: string) => {
    if (isServerHref(href)) return { href, go: () => void window.open(href, '_blank', 'noopener') }
    const file = fileFocusOf(href, spaceId)
    if (!file) return { href: routeHref(href), go: () => jumpTo(href, label) }
    const page = spacePath(file.ref.spaceId!, filePagePath(file))
    return { href: page, go: () => (focus ? focus.open(file) : jumpTo(page, label)) }
  }, [focus, spaceId])
}

const KIND: Record<NonNullable<StewardCitation['kind']>, { icon: LucideIcon; label: string }> = {
  space: { icon: FolderKanban, label: '空间' },
  requirement: { icon: ListChecks, label: '需求' },
  run: { icon: PlayCircle, label: '运行' },
  node: { icon: Workflow, label: '节点' },
  workflow: { icon: Workflow, label: 'workflow' },
  knowledge: { icon: BookOpen, label: '知识库' },
  file: { icon: FileText, label: '文件' },
  event: { icon: Radio, label: '事件' },
  attention: { icon: Inbox, label: '待办' },
  risk: { icon: CircleAlert, label: '风险' },
}

export const citationKind = (c: StewardCitation) => KIND[c.kind ?? 'event'] ?? KIND.event

/** 正文里的 [n]：悬停 250ms 预览来源，点击跳转并在目标页高亮定位。 */
export function CitationRef({ n, c }: { n: number; c: StewardCitation }) {
  const opener = useLinkOpener()
  const ref = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const show = () => {
    clearTimeout(timer.current)
    timer.current = setTimeout(() => setOpen(true), 250)
  }
  const hide = () => {
    clearTimeout(timer.current)
    timer.current = setTimeout(() => setOpen(false), 120)
  }
  const k = citationKind(c)
  const Icon = k.icon
  const path = c.href.replace(/^\/s\/[^/]+/, '').split('?')[0]
  return (
    <>
      <button
        ref={ref}
        type="button"
        className="stw-cite pressable"
        aria-label={`来源 ${n}：${c.label}`}
        onMouseEnter={show}
        onMouseLeave={hide}
        onFocus={show}
        onBlur={hide}
        onClick={() => {
          setOpen(false)
          opener(c.href, c.label).go()
        }}
      >
        {n}
      </button>
      <Popover open={open} onClose={() => setOpen(false)} anchor={ref} placement="top-start" className="stw-cite-pop">
        <div onMouseEnter={show} onMouseLeave={hide} className="stw-cite-card">
          <span className="stw-cite-kind">
            <Icon aria-hidden />
            {k.label}
          </span>
          <span className="stw-cite-label">{c.label}</span>
          <span className="stw-cite-path mono truncate">{path}</span>
          <span className="stw-cite-go">
            {isServerHref(c.href) ? '点击在新标签页打开' : '点击跳转并定位'} <ArrowUpRight aria-hidden />
          </span>
        </div>
      </Popover>
    </>
  )
}

/** 粗体、行内代码、Markdown 链接 [文字](/站内路径 或 http(s) 地址)、指向引用的链接 [文字]([n])、[n] 引用。 */
const INLINE = /(\*\*[^*]+\*\*)|(`[^`]+`)|\[([^\]\n]+)\]\(((?:\/|https?:\/\/)[^)\s]*)\)|\[([^\]\n]+)\]\(\[(\d+)\]\)|(\[\d+\])/g

function inline(text: string, cites: StewardCitation[] | undefined, key: string, opener: LinkOpener): ReactNode[] {
  const out: ReactNode[] = []
  let last = 0
  let i = 0
  for (const m of text.matchAll(INLINE)) {
    if (m.index > last) out.push(text.slice(last, m.index))
    const k = `${key}-${i++}`
    if (m[1]) out.push(<strong key={k}>{inline(m[1].slice(2, -2), cites, k, opener)}</strong>)
    else if (m[2]) out.push(<code key={k}>{m[2].slice(1, -1)}</code>)
    else if (m[3] && m[4]) {
      const href = m[4]
      const link = href.startsWith('/') ? opener(href, m[3]) : undefined
      // 站内路径走 jumpTo（带空间前缀与高亮），产物文件在右侧面板打开，外链新开标签页
      out.push(
        link ? (
          <a key={k} href={link.href} className="stw-link" onClick={(e) => (e.preventDefault(), link.go())}>
            {m[3]}
          </a>
        ) : (
          <a key={k} href={href} className="stw-link" target="_blank" rel="noreferrer noopener">
            {m[3]}
          </a>
        ),
      )
    } else if (m[5] && m[6]) {
      // 模型有时把引用写成链接目标：用引用的地址做链接，后面仍带来源角标
      const n = Number(m[6])
      const c = cites?.[n - 1]
      const link = c && opener(c.href, c.label)
      out.push(
        link && c ? (
          <Fragment key={k}>
            <a href={link.href} className="stw-link" onClick={(e) => (e.preventDefault(), link.go())}>
              {m[5]}
            </a>
            <CitationRef n={n} c={c} />
          </Fragment>
        ) : (
          <Fragment key={k}>{m[5]}</Fragment>
        ),
      )
    } else {
      const n = Number(m[7]!.slice(1, -1))
      const c = cites?.[n - 1]
      out.push(c ? <CitationRef key={k} n={n} c={c} /> : <Fragment key={k}>{m[7]}</Fragment>)
    }
    last = m.index + m[0].length
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}

/** 代码块右上角带复制：管家给的代码（HTML、配置）常要原样拿去用。 */
function StewardCode({ lang, code }: { lang: string; code: string }) {
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code)
      toast('已复制代码', { tone: 'success', duration: 2000 })
    } catch {
      toast('浏览器不允许复制', { tone: 'failed' })
    }
  }
  return (
    <div className="stw-code">
      <CodeBlock lang={lang} code={code} />
      <button type="button" className="btn btn-ghost btn-icon btn-sm stw-code-copy" title="复制代码" aria-label="复制代码" onClick={() => void copy()}>
        <Copy />
      </button>
    </div>
  )
}

/**
 * 管家正文：用 lib/markdown 渲染标题、列表（含有序）、表格、代码块、引用；行内是粗体、行内代码、链接、[n] 引用；
 * 段内换行保留。流式时还没闭合的代码围栏先按代码块显示，最后一段末尾带光标（样式见 steward.css）。
 */
export function StewardText({ text, citations, streaming }: { text: string; citations?: StewardCitation[]; streaming?: boolean }) {
  const opener = useLinkOpener()
  return (
    <div className="stw-text" data-streaming={streaming || undefined}>
      <Markdown source={text} breaks inline={(t, key) => inline(t, citations, key, opener)} code={(lang, code) => <StewardCode lang={lang} code={code} />} />
    </div>
  )
}
