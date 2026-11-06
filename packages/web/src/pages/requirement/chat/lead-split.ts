/** Lead 消息的标签块切分（纯函数，lead-text.tsx 渲染用；单测见 lead-split.test.ts）。 */
export type Seg = { kind: 'plain' | 'confirm' | 'next'; text: string }

const MARK = /\*\*(待确认|下一步)\*\*[:：]?[ \t]*/g

/** 把 Lead 消息切成：普通段落 + `**待确认**` / `**下一步**` 起头的标签块（块延续到下一个标签或结尾）。 */
export function splitLeadText(text: string): Seg[] {
  const out: Seg[] = []
  let last = 0
  let kind: Seg['kind'] = 'plain'
  for (const m of text.matchAll(MARK)) {
    const chunk = text.slice(last, m.index).trim()
    if (chunk) out.push({ kind, text: chunk })
    kind = m[1] === '待确认' ? 'confirm' : 'next'
    last = m.index! + m[0].length
  }
  const tail = text.slice(last).trim()
  if (tail || kind !== 'plain') out.push({ kind, text: tail })
  return out
}

export function hasLeadMarks(text: string): boolean {
  return /\*\*(待确认|下一步)\*\*/.test(text)
}
