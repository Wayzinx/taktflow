import { Fragment, useRef, useState, type ReactNode } from 'react'
import { ArrowUpRight, BookOpen, CircleAlert, FileText, FolderKanban, Inbox, ListChecks, PlayCircle, Radio, Workflow, type LucideIcon } from 'lucide-react'
import type { StewardCitation } from '@taktflow/core'
import { Popover } from '../ui'
import { jumpTo } from './jump'

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
          jumpTo(c.href, c.label)
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
            点击跳转并定位 <ArrowUpRight aria-hidden />
          </span>
        </div>
      </Popover>
    </>
  )
}

/** 粗体、行内代码、Markdown 链接 [文字](/站内路径 或 http(s) 地址)、[n] 引用。 */
const INLINE = /(\*\*[^*]+\*\*)|(`[^`]+`)|\[([^\]\n]+)\]\(((?:\/|https?:\/\/)[^)\s]*)\)|(\[\d+\])/g

function inline(text: string, cites: StewardCitation[] | undefined, key: string): ReactNode[] {
  const out: ReactNode[] = []
  let last = 0
  let i = 0
  for (const m of text.matchAll(INLINE)) {
    if (m.index > last) out.push(text.slice(last, m.index))
    const k = `${key}-${i++}`
    if (m[1]) out.push(<strong key={k}>{inline(m[1].slice(2, -2), cites, k)}</strong>)
    else if (m[2]) out.push(<code key={k}>{m[2].slice(1, -1)}</code>)
    else if (m[3] && m[4]) {
      const href = m[4]
      // 站内路径走 jumpTo（带空间前缀与高亮），外链新开标签页
      out.push(
        href.startsWith('/') ? (
          <a key={k} href={href} className="stw-link" onClick={(e) => (e.preventDefault(), jumpTo(href, m[3]))}>
            {m[3]}
          </a>
        ) : (
          <a key={k} href={href} className="stw-link" target="_blank" rel="noreferrer noopener">
            {m[3]}
          </a>
        ),
      )
    } else {
      const n = Number(m[5]!.slice(1, -1))
      const c = cites?.[n - 1]
      out.push(c ? <CitationRef key={k} n={n} c={c} /> : <Fragment key={k}>{m[5]}</Fragment>)
    }
    last = m.index + m[0].length
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}

/** 管家正文：段落、行首 "- " 列表、粗体、行内代码、链接、[n] 引用；流式时最后一段末尾带光标。 */
export function StewardText({ text, citations, streaming }: { text: string; citations?: StewardCitation[]; streaming?: boolean }) {
  const blocks = text.split(/\n{2,}/)
  return (
    <div className="stw-text">
      {blocks.map((b, bi) => {
        const last = bi === blocks.length - 1
        const lines = b.split('\n')
        if (lines.every((l) => /^\s*[-*] /.test(l)))
          return (
            <ul key={bi}>
              {lines.map((l, li) => (
                <li key={li} className={streaming && last && li === lines.length - 1 ? 'stream-caret' : undefined}>{inline(l.replace(/^\s*[-*] /, ''), citations, `${bi}-${li}`)}</li>
              ))}
            </ul>
          )
        return (
          <p key={bi} className={streaming && last ? 'stream-caret' : undefined}>
            {lines.map((l, li) => (
              <Fragment key={li}>
                {li > 0 && <br />}
                {inline(l, citations, `${bi}-${li}`)}
              </Fragment>
            ))}
          </p>
        )
      })}
    </div>
  )
}
