import type { ReactNode } from 'react'

const TOKEN = /("(?:\\.|[^"\\])*")(\s*:)?|\b(true|false|null)\b|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|([{}[\],])/g

/** JSON 高亮：键、字符串、数字、字面量、标点各一色。 */
export function JsonView({ source }: { source: string }) {
  let text = source
  try {
    text = JSON.stringify(JSON.parse(source), null, 2)
  } catch {
    // 不是合法 JSON 时按原文高亮
  }
  const out: ReactNode[] = []
  let last = 0
  let i = 0
  for (const m of text.matchAll(TOKEN)) {
    if (m.index > last) out.push(text.slice(last, m.index))
    const cls = m[1] ? (m[2] ? 'k' : 's') : m[3] ? 'l' : m[4] ? 'n' : 'p'
    out.push(
      <span key={i++} className={`j-${cls}`}>
        {m[1] ?? m[0]}
      </span>,
    )
    if (m[1] && m[2]) out.push(m[2])
    last = m.index + m[0].length
  }
  if (last < text.length) out.push(text.slice(last))
  return <pre className="json-view">{out}</pre>
}
