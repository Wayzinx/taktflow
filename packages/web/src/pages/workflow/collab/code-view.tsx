import { useEffect, useMemo, useRef, type ReactNode } from 'react'

/** workflow 源码（TS 受限子集）的轻量高亮：注释、字符串、数字、关键字、属性键、调用名、标点。 */
const TOKEN = /(\/\/[^\n]*|\/\*[\s\S]*?\*\/)|('(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"|`(?:\\.|[^`\\])*`)|\b(\d+(?:\.\d+)?)\b|\b(import|from|export|default|const|let|return|async|await|function|true|false|null|undefined|new|if|else|as|type)\b|([A-Za-z_$][\w$]*)(?=\s*:(?!:))|([A-Za-z_$][\w$]*)(?=\s*\()|([{}[\](),;.=>:?]+)/g

const CLASS = ['', 'c', 's', 'n', 'k', 'p', 'f', 'u'] as const

interface Tok {
  cls: string
  text: string
}

/** 把整段源码切成按行分组的 token；跨行的块注释 / 模板字符串会被拆到各行。 */
export function tokenizeLines(source: string): Tok[][] {
  const lines: Tok[][] = [[]]
  const push = (cls: string, text: string) => {
    const parts = text.split('\n')
    parts.forEach((part, i) => {
      if (i > 0) lines.push([])
      if (part) lines[lines.length - 1]!.push({ cls, text: part })
    })
  }
  let last = 0
  for (const m of source.matchAll(TOKEN)) {
    if (m.index > last) push('', source.slice(last, m.index))
    const g = m.findIndex((x, i) => i > 0 && x !== undefined)
    push(CLASS[g] ?? '', m[0])
    last = m.index + m[0].length
  }
  if (last < source.length) push('', source.slice(last))
  return lines
}

export function renderTokens(toks: Tok[]): ReactNode[] {
  return toks.map((t, i) => (t.cls ? <span key={i} className={`hl-${t.cls}`}>{t.text}</span> : t.text))
}

/** 单行高亮（diff 行用）。 */
export function HighlightLine({ text }: { text: string }) {
  return <>{renderTokens(tokenizeLines(text)[0] ?? [])}</>
}

export interface LineMark {
  severity: 'error' | 'warning'
  message: string
}

/**
 * 带行号的只读代码块。marks：按行号挂诊断（行尾给出原因）；highlight：需要强调的行（远端变更的节点）；
 * focusLine 变化时滚动到该行。
 */
export function CodeView({ source, marks, highlight, focusLine, label }: { source: string; marks?: Map<number, LineMark[]>; highlight?: Set<number>; focusLine?: number; label?: string }) {
  const lines = useMemo(() => tokenizeLines(source), [source])
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!focusLine) return
    box.current?.querySelector(`[data-line="${focusLine}"]`)?.scrollIntoView({ block: 'center', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' })
  }, [focusLine])
  return (
    <div className="wfc-code" ref={box} role="region" aria-label={label ?? '源码'} tabIndex={0}>
      {lines.map((toks, i) => {
        const n = i + 1
        const m = marks?.get(n)
        const sev = m?.some((x) => x.severity === 'error') ? 'error' : m ? 'warning' : undefined
        return (
          <div key={n} data-line={n} className={`wfc-line${sev ? ` is-${sev}` : ''}${highlight?.has(n) ? ' is-hl' : ''}${focusLine === n ? ' is-focus' : ''}`}>
            <span className="wfc-ln" aria-hidden>{n}</span>
            <span className="wfc-src">
              {renderTokens(toks)}
              {toks.length === 0 && ' '}
            </span>
            {m && (
              <span className={`wfc-note is-${sev}`} title={m.map((x) => x.message).join('\n')}>
                {m[0]!.message}
                {m.length > 1 && ` 等 ${m.length} 条`}
              </span>
            )}
          </div>
        )
      })}
    </div>
  )
}
