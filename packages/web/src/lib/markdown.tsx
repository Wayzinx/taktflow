import { Fragment, type ReactNode } from 'react'
import './markdown.css'

/**
 * 轻量 Markdown 渲染：标题、段落、列表（可嵌套）、代码块（diff 着色）、表格、引用、分隔线、
 * 行内代码、粗体、斜体、链接。直接生成 React 元素，不拼 HTML，天然防注入。
 */

const INLINE = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\[[^\]]+\]\([^)\s]+\))|(\*[^*\s][^*]*\*)/g

function inline(text: string, keyBase = ''): ReactNode[] {
  const out: ReactNode[] = []
  let last = 0
  let i = 0
  for (const m of text.matchAll(INLINE)) {
    const idx = m.index
    if (idx > last) out.push(text.slice(last, idx))
    const tok = m[0]
    const key = `${keyBase}-${i++}`
    if (m[1]) out.push(<code key={key}>{tok.slice(1, -1)}</code>)
    else if (m[2]) out.push(<strong key={key}>{inline(tok.slice(2, -2), key)}</strong>)
    else if (m[3]) {
      const lm = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(tok)!
      const url = lm[2]!
      const safe = /^(https?:|mailto:|#|\/)/.test(url) ? url : '#'
      out.push(
        <a key={key} href={safe} target={safe.startsWith('http') ? '_blank' : undefined} rel="noreferrer">
          {inline(lm[1]!, key)}
        </a>,
      )
    } else if (m[4]) out.push(<em key={key}>{inline(tok.slice(1, -1), key)}</em>)
    last = idx + tok.length
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}

interface ListItem {
  text: string[]
  children: ListNode | null
}
interface ListNode {
  ordered: boolean
  start: number
  items: ListItem[]
}

const LIST_RE = /^(\s*)([-*+]|\d+\.)\s+(.*)$/

function parseList(lines: string[]): ListNode {
  const first = LIST_RE.exec(lines[0]!)!
  const baseIndent = first[1]!.length
  const ordered = /\d/.test(first[2]!)
  const node: ListNode = { ordered, start: ordered ? parseInt(first[2]!, 10) : 1, items: [] }
  let i = 0
  while (i < lines.length) {
    const m = LIST_RE.exec(lines[i]!)
    if (m && m[1]!.length === baseIndent) {
      node.items.push({ text: [m[3]!], children: null })
      i++
      continue
    }
    // 更深缩进：子列表或续行
    const sub: string[] = []
    while (i < lines.length) {
      const mm = LIST_RE.exec(lines[i]!)
      if (mm && mm[1]!.length <= baseIndent) break
      sub.push(lines[i]!)
      i++
    }
    const item = node.items[node.items.length - 1]
    if (!item) break
    const subList = sub.filter((l) => LIST_RE.test(l))
    const cont = sub.filter((l) => !LIST_RE.test(l))
    item.text.push(...cont.map((l) => l.trim()))
    if (subList.length) item.children = parseList(sub.filter((l) => LIST_RE.test(l) || l.trim()))
  }
  return node
}

function renderList(node: ListNode, key: string): ReactNode {
  const items = node.items.map((it, i) => (
    <li key={i}>
      {inline(it.text.join(' '), `${key}-${i}`)}
      {it.children && renderList(it.children, `${key}-${i}-c`)}
    </li>
  ))
  return node.ordered ? (
    <ol key={key} start={node.start}>
      {items}
    </ol>
  ) : (
    <ul key={key}>{items}</ul>
  )
}

const splitRow = (line: string) =>
  line
    .trim()
    .replace(/^\||\|$/g, '')
    .split('|')
    .map((c) => c.trim())

function CodeBlock({ lang, code }: { lang: string; code: string }) {
  if (lang === 'diff') {
    return (
      <pre className="md-code md-diff">
        {code.split('\n').map((l, i) => (
          <span key={i} className={l.startsWith('+') ? 'add' : l.startsWith('-') ? 'del' : undefined}>
            {l || ' '}
            {'\n'}
          </span>
        ))}
      </pre>
    )
  }
  return (
    <pre className="md-code" data-lang={lang || undefined}>
      <code>{code}</code>
    </pre>
  )
}

export function Markdown({ source }: { source: string }) {
  const lines = source.replace(/\r\n/g, '\n').split('\n')
  const blocks: ReactNode[] = []
  let i = 0
  let k = 0
  while (i < lines.length) {
    const line = lines[i]!
    const key = `b${k++}`
    if (!line.trim()) {
      i++
      continue
    }
    const fence = /^```(\w*)/.exec(line)
    if (fence) {
      const body: string[] = []
      i++
      while (i < lines.length && !lines[i]!.startsWith('```')) body.push(lines[i++]!)
      i++
      blocks.push(<CodeBlock key={key} lang={fence[1] ?? ''} code={body.join('\n')} />)
      continue
    }
    const h = /^(#{1,4})\s+(.*)$/.exec(line)
    if (h) {
      const level = h[1]!.length
      const content = inline(h[2]!, key)
      blocks.push(level === 1 ? <h1 key={key}>{content}</h1> : level === 2 ? <h2 key={key}>{content}</h2> : level === 3 ? <h3 key={key}>{content}</h3> : <h4 key={key}>{content}</h4>)
      i++
      continue
    }
    if (/^(-{3,}|\*{3,})\s*$/.test(line)) {
      blocks.push(<hr key={key} />)
      i++
      continue
    }
    if (line.startsWith('>')) {
      const body: string[] = []
      while (i < lines.length && lines[i]!.startsWith('>')) body.push(lines[i++]!.replace(/^>\s?/, ''))
      blocks.push(
        <blockquote key={key}>
          <Markdown source={body.join('\n')} />
        </blockquote>,
      )
      continue
    }
    if (line.includes('|') && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1]!)) {
      const head = splitRow(line)
      const align = splitRow(lines[i + 1]!).map((c) => (c.endsWith(':') ? (c.startsWith(':') ? 'center' : 'right') : undefined))
      i += 2
      const rows: string[][] = []
      while (i < lines.length && lines[i]!.includes('|') && lines[i]!.trim()) rows.push(splitRow(lines[i++]!))
      blocks.push(
        <div className="md-table-wrap" key={key}>
          <table>
            <thead>
              <tr>
                {head.map((c, j) => (
                  <th key={j} style={{ textAlign: align[j] }}>
                    {inline(c, `${key}h${j}`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, ri) => (
                <tr key={ri}>
                  {head.map((_, j) => (
                    <td key={j} style={{ textAlign: align[j] }}>
                      {inline(r[j] ?? '', `${key}r${ri}c${j}`)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      )
      continue
    }
    if (LIST_RE.test(line)) {
      const body: string[] = []
      while (i < lines.length && (LIST_RE.test(lines[i]!) || (/^\s{2,}\S/.test(lines[i]!) && body.length > 0))) body.push(lines[i++]!)
      blocks.push(renderList(parseList(body), key))
      continue
    }
    const para: string[] = []
    while (i < lines.length && lines[i]!.trim() && !/^(#{1,4}\s|```|>|\s*([-*+]|\d+\.)\s)/.test(lines[i]!)) para.push(lines[i++]!)
    if (para.length === 0) para.push(lines[i++]!)
    blocks.push(<p key={key}>{inline(para.join(' '), key)}</p>)
  }
  return <div className="md">{blocks.map((b, j) => <Fragment key={j}>{b}</Fragment>)}</div>
}
