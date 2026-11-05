import { useEffect, useState, type ReactNode } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import { withCurrent, type Option } from './options'

/** 本地草稿：外部值变了（撤销、远端修改）就丢弃草稿；提交在失焦 / 回车时发生，避免每次按键产生一条修订。 */
export function useDraft<T>(value: T): [T, (v: T) => void, boolean] {
  const [draft, setDraft] = useState(value)
  const key = JSON.stringify(value)
  useEffect(() => setDraft(value), [key]) // eslint-disable-line react-hooks/exhaustive-deps
  return [draft, setDraft, JSON.stringify(draft) !== key]
}

export function Field({ label, hint, children, htmlFor }: { label: string; hint?: ReactNode; children: ReactNode; htmlFor?: string }) {
  return (
    <div className="wf-field">
      <label htmlFor={htmlFor}>{label}</label>
      {children}
      {hint && <p className="wf-field-hint">{hint}</p>}
    </div>
  )
}

interface Base<T> {
  id: string
  value: T
  disabled?: boolean
  onCommit(v: T): void
}

export function TextInput({ id, value, disabled, onCommit, mono, placeholder }: Base<string> & { mono?: boolean; placeholder?: string }) {
  const [d, set, dirty] = useDraft(value)
  return (
    <input
      id={id}
      className={`input${mono ? ' mono' : ''}`}
      value={d}
      placeholder={placeholder}
      disabled={disabled}
      onChange={(e) => set(e.target.value)}
      onBlur={() => dirty && onCommit(d)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur()
        if (e.key === 'Escape') set(value)
      }}
    />
  )
}

export function LongText({ id, value, disabled, onCommit, mono, rows = 5 }: Base<string> & { mono?: boolean; rows?: number }) {
  const [d, set, dirty] = useDraft(value)
  return (
    <>
      <textarea
        id={id}
        className={`textarea${mono ? ' mono' : ''}`}
        rows={rows}
        value={d}
        disabled={disabled}
        onChange={(e) => set(e.target.value)}
        onBlur={() => dirty && onCommit(d)}
        onKeyDown={(e) => e.key === 'Enter' && (e.metaKey || e.ctrlKey) && e.currentTarget.blur()}
      />
      {dirty && <p className="wf-field-hint">未保存 · 失焦或 ⌘↵ 保存</p>}
    </>
  )
}

export function NumberInput({ id, value, disabled, onCommit, min, max }: Base<number | undefined> & { min?: number; max?: number }) {
  const [d, set, dirty] = useDraft(value === undefined ? '' : String(value))
  const commit = () => {
    if (!dirty) return
    const n = Number(d)
    if (d === '') return onCommit(undefined)
    if (Number.isFinite(n)) onCommit(Math.max(min ?? -Infinity, Math.min(max ?? Infinity, n)))
    else set(value === undefined ? '' : String(value))
  }
  return <input id={id} className="input wf-num" type="number" min={min} max={max} value={d} disabled={disabled} onChange={(e) => set(e.target.value)} onBlur={commit} onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()} />
}

export function Toggle({ id, value, disabled, onCommit, label }: Base<boolean> & { label: string }) {
  return (
    <label className="wf-check" htmlFor={id}>
      <input id={id} type="checkbox" checked={value} disabled={disabled} onChange={(e) => onCommit(e.target.checked)} />
      {label}
    </label>
  )
}

export function Select({ id, value, disabled, onCommit, options, empty }: Base<string | undefined> & { options: Option[]; empty?: string }) {
  return (
    <select id={id} className="select" value={value ?? ''} disabled={disabled} onChange={(e) => onCommit(e.target.value || undefined)}>
      {empty !== undefined && <option value="">{empty}</option>}
      {withCurrent(options, value).map((o) => (
        <option key={o.value} value={o.value}>{o.label}</option>
      ))}
    </select>
  )
}

export interface Column {
  key: string
  label: string
  options?: Option[]
  mono?: boolean
}

/** 数组编辑：字符串数组（columns 为空）或对象数组（每列一个键）。整行在失焦时提交。 */
export function ListEditor({ id, value, disabled, onCommit, columns, placeholder, addLabel = '添加一项' }: Base<unknown[]> & { columns?: Column[]; placeholder?: string; addLabel?: string }) {
  const [d, set, dirty] = useDraft(value)
  const rows = d as Array<string | Record<string, unknown>>
  const commit = (next = rows) => {
    const clean = next.filter((r) => (typeof r === 'string' ? r.trim() : Object.values(r).some((v) => v !== '' && v !== undefined)))
    if (JSON.stringify(clean) !== JSON.stringify(value)) onCommit(clean)
  }
  const patch = (i: number, v: string | Record<string, unknown>) => set(rows.map((r, j) => (j === i ? v : r)))
  const cell = (r: Record<string, unknown>, c: Column, i: number) => {
    const v = typeof r[c.key] === 'string' ? (r[c.key] as string) : ''
    const update = (x: string) => {
      const next = { ...r }
      if (x) next[c.key] = x
      else delete next[c.key]
      return next
    }
    if (c.options)
      return (
        <select key={c.key} className="select" value={v} disabled={disabled} aria-label={c.label} onChange={(e) => { const next = rows.map((x, j) => (j === i ? update(e.target.value) : x)); set(next); commit(next) }}>
          <option value="">{c.label}</option>
          {withCurrent(c.options, v).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      )
    return <input key={c.key} className={`input${c.mono ? ' mono' : ''}`} placeholder={c.label} aria-label={c.label} value={v} disabled={disabled} onChange={(e) => patch(i, update(e.target.value))} onBlur={() => dirty && commit()} />
  }
  return (
    <div className="wf-list" id={id}>
      {rows.map((r, i) => (
        <div className={`wf-list-row cols-${columns?.length ?? 1}`} key={i}>
          {typeof r === 'string' || !columns ? (
            <input className="input mono" value={String(r)} placeholder={placeholder} disabled={disabled} aria-label={`第 ${i + 1} 项`} onChange={(e) => patch(i, e.target.value)} onBlur={() => dirty && commit()} />
          ) : (
            columns.map((c) => cell(r, c, i))
          )}
          {!disabled && (
            <button className="btn btn-ghost btn-sm btn-icon" onClick={() => commit(rows.filter((_, j) => j !== i))} aria-label={`删除第 ${i + 1} 项`}>
              <Trash2 />
            </button>
          )}
        </div>
      ))}
      {!disabled && (
        <button className="btn btn-sm wf-add-row" onClick={() => set([...rows, columns ? {} : ''])}>
          <Plus />
          {addLabel}
        </button>
      )}
    </div>
  )
}

/** 结构复杂的字面量（门禁检查、参数）用 JSON 文本编辑，解析失败不提交。 */
export function JsonEditor({ id, value, disabled, onCommit }: Base<unknown>) {
  const text = JSON.stringify(value, null, 2) ?? ''
  const [d, set, dirty] = useDraft(text)
  const [err, setErr] = useState<string>()
  const commit = () => {
    if (!dirty) return
    try {
      onCommit(JSON.parse(d))
      setErr(undefined)
    } catch (e) {
      setErr(`JSON 无效：${(e as Error).message}`)
    }
  }
  return (
    <>
      <textarea id={id} className="textarea mono" rows={Math.min(10, text.split('\n').length + 1)} value={d} disabled={disabled} onChange={(e) => set(e.target.value)} onBlur={commit} aria-invalid={!!err} />
      {err && <p className="wf-field-hint is-error" role="alert">{err}</p>}
    </>
  )
}
