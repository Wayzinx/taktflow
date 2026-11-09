import { useMemo, type ReactNode } from 'react'
import { parseMarkdown, type MdBlock } from './markdown-parse'
import './markdown.css'

/**
 * 轻量 Markdown 渲染：标题、段落、列表（可嵌套）、代码块（diff 着色）、表格、引用、分隔线、
 * 行内代码、粗体、斜体、链接。直接生成 React 元素，不拼 HTML，天然防注入。块结构的解析在 markdown-parse.ts。
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
  const blocks = useMemo(() => parseMarkdown(source), [source])
  return <div className="md">{renderBlocks(blocks, 'b')}</div>
}

function renderBlocks(blocks: MdBlock[], keyBase: string): ReactNode[] {
  return blocks.map((block, j) => {
    const key = `${keyBase}${j}`
    switch (block.type) {
      case 'heading': {
        const content = inline(block.text, key)
        return block.level === 1 ? <h1 key={key}>{content}</h1> : block.level === 2 ? <h2 key={key}>{content}</h2> : block.level === 3 ? <h3 key={key}>{content}</h3> : <h4 key={key}>{content}</h4>
      }
      case 'paragraph':
        return <p key={key}>{inline(block.text, key)}</p>
      case 'hr':
        return <hr key={key} />
      case 'code':
        return <CodeBlock key={key} lang={block.lang} code={block.code} />
      case 'quote':
        return <blockquote key={key}>{renderBlocks(block.blocks, `${key}q`)}</blockquote>
      case 'table':
        return (
          <div className="md-table-wrap" key={key}>
            <table>
              <thead>
                <tr>
                  {block.head.map((c, i) => (
                    <th key={i} style={{ textAlign: block.align[i] }}>
                      {inline(c, `${key}h${i}`)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {block.rows.map((r, ri) => (
                  <tr key={ri}>
                    {block.head.map((_, i) => (
                      <td key={i} style={{ textAlign: block.align[i] }}>
                        {inline(r[i] ?? '', `${key}r${ri}c${i}`)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      case 'list': {
        const items = block.items.map((it, i) => (
          <li key={i}>
            {inline(it.text, `${key}-${i}`)}
            {renderBlocks(it.blocks, `${key}-${i}-`)}
          </li>
        ))
        return block.ordered ? (
          <ol key={key} start={block.start}>
            {items}
          </ol>
        ) : (
          <ul key={key}>{items}</ul>
        )
      }
    }
  })
}
