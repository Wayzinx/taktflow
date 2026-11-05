import { useState, type ReactNode } from 'react'
import { Code2, Pencil } from 'lucide-react'
import { useDraft } from './fields'

const KEYWORDS = new Set(['const', 'let', 'var', 'return', 'function', 'if', 'else', 'await', 'async', 'new', 'true', 'false', 'null', 'undefined', 'typeof', 'of', 'in', 'for'])
const TOKEN = /(\/\/[^\n]*|\/\*[\s\S]*?\*\/)|('(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|`(?:\\.|[^`\\])*`)|(\b\d+(?:\.\d+)?\b)|([A-Za-z_$][\w$]*)(\s*:)?|(=>|[{}()[\].,;:?!=<>+\-*/|&]+)/g

/** 极简 TS 高亮：注释、字符串、数字、关键字、对象键、标点；只为读得清楚，不做语义分析。 */
export function highlight(src: string): ReactNode[] {
  const out: ReactNode[] = []
  let last = 0
  for (const m of src.matchAll(TOKEN)) {
    const i = m.index
    if (i > last) out.push(src.slice(last, i))
    const [all, comment, str, num, ident, colon, punc] = m
    const k = out.length
    if (comment) out.push(<span key={k} className="tk-comment">{comment}</span>)
    else if (str) out.push(<span key={k} className="tk-str">{str}</span>)
    else if (num) out.push(<span key={k} className="tk-num">{num}</span>)
    else if (ident && colon) out.push(<span key={k} className="tk-key">{ident}</span>, colon)
    else if (ident && KEYWORDS.has(ident)) out.push(<span key={k} className="tk-lit">{ident}</span>)
    else if (ident) out.push(src[i + ident.length] === '(' ? <span key={k} className="tk-fn">{ident}</span> : ident)
    else if (punc) out.push(<span key={k} className="tk-punc">{punc}</span>)
    else out.push(all)
    last = i + all.length
  }
  if (last < src.length) out.push(src.slice(last))
  return out
}

/** 代码值：默认只读高亮；点"编辑"切到文本框，保存时以代码值写回（setProp code）。 */
export function CodeValue({ id, code, disabled, onCommit }: { id: string; code: string; disabled?: boolean; onCommit?(code: string): void }) {
  const [editing, setEditing] = useState(false)
  const [d, set, dirty] = useDraft(code)
  if (editing && !disabled)
    return (
      <div className="wf-code is-editing">
        <textarea
          id={id}
          className="textarea mono"
          rows={Math.min(12, Math.max(3, d.split('\n').length + 1))}
          value={d}
          autoFocus
          spellCheck={false}
          onChange={(e) => set(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              set(code)
              setEditing(false)
            }
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && d.trim()) {
              if (dirty) onCommit?.(d)
              setEditing(false)
            }
          }}
        />
        <div className="wf-code-actions">
          <span className="wf-field-hint">TypeScript 表达式，原样写回源码</span>
          <button className="btn btn-sm btn-ghost" onClick={() => { set(code); setEditing(false) }}>取消</button>
          <button className="btn btn-sm btn-primary" disabled={!d.trim()} onClick={() => { if (dirty) onCommit?.(d); setEditing(false) }}>保存</button>
        </div>
      </div>
    )
  return (
    <div className="wf-code">
      <span className="wf-code-tag" title="代码值：画布不解析，原样保留在源码里">
        <Code2 />
        代码
      </span>
      <pre id={id} className="mono" tabIndex={0}>{highlight(code)}</pre>
      {!disabled && onCommit && (
        <button className="btn btn-sm btn-ghost wf-code-edit" onClick={() => setEditing(true)} aria-label="以文本编辑代码值">
          <Pencil />
          编辑
        </button>
      )}
    </div>
  )
}
