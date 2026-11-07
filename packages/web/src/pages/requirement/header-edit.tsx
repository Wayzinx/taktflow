import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { Pencil } from 'lucide-react'
import { Popover, toast } from '../../components/ui'

/**
 * 就地编辑：平时是普通文本（悬停出现铅笔），点一下变输入框。
 * 单行 Enter 保存、多行 ⌘Enter 保存；Esc 取消；失焦时有改动就保存。保存中半透明，失败留在编辑态。
 */
export function InlineText({
  value,
  onSave,
  multiline,
  placeholder,
  className,
  label,
  view,
}: {
  value: string
  onSave: (v: string) => Promise<void>
  multiline?: boolean
  placeholder?: string
  className?: string
  label: string
  /** 自定义只读态的渲染（默认就是文本） */
  view?: ReactNode
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(value)
  const [busy, setBusy] = useState(false)
  const ref = useRef<HTMLInputElement & HTMLTextAreaElement>(null)
  useEffect(() => {
    if (!editing) setDraft(value)
  }, [value, editing])
  useEffect(() => {
    if (!editing) return
    ref.current?.focus()
    if (!multiline) ref.current?.select()
  }, [editing, multiline])

  const commit = async () => {
    const v = draft.trim()
    if (busy) return
    if (v === value.trim() || (!v && !multiline)) {
      setEditing(false)
      setDraft(value)
      return
    }
    setBusy(true)
    try {
      await onSave(v)
      setEditing(false)
    } catch (e) {
      toast(`${label}没保存上`, { tone: 'failed', body: (e as Error).message })
      ref.current?.focus()
    } finally {
      setBusy(false)
    }
  }
  const cancel = () => {
    setDraft(value)
    setEditing(false)
  }

  if (!editing)
    return (
      <button type="button" className={`rh-inline ${className ?? ''}${value ? '' : ' empty'}`} onClick={() => setEditing(true)} title={`编辑${label}`}>
        {view ?? (value || <span className="faint">{placeholder}</span>)}
        <Pencil className="rh-pencil" aria-hidden />
      </button>
    )
  const common = {
    ref,
    value: draft,
    'aria-label': label,
    placeholder,
    disabled: busy,
    onChange: (e: { target: { value: string } }) => setDraft(e.target.value),
    onBlur: () => void commit(),
    onKeyDown: (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        cancel()
      } else if (e.key === 'Enter' && (!multiline || e.metaKey || e.ctrlKey)) {
        e.preventDefault()
        void commit()
      }
    },
  }
  return multiline ? (
    <div className="rh-edit-wrap">
      <textarea {...common} className={`textarea rh-edit-area ${className ?? ''}`} rows={Math.min(12, Math.max(3, draft.split('\n').length + 1))} />
      <span className="rh-edit-hint faint">⌘Enter 保存 · Esc 取消</span>
    </div>
  ) : (
    <input {...common} className={`rh-edit-input ${className ?? ''}${busy ? ' busy' : ''}`} maxLength={160} />
  )
}

/** 事实行里可点的一项（负责人、截止时间）：点开是浮层。 */
export function FactButton({ children, label, pop, width = 260 }: { children: ReactNode; label: string; pop: (close: () => void) => ReactNode; width?: number }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLButtonElement>(null)
  return (
    <>
      <button ref={ref} type="button" className="req-fact rh-fact-btn" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen((o) => !o)} title={`修改${label}`}>
        {children}
      </button>
      <Popover open={open} onClose={() => setOpen(false)} anchor={ref} className="rc-pop" ariaLabel={label} role="dialog">
        <div className="rc-pop-inner" style={{ width }}>
          <div className="rc-pop-title">{label}</div>
          {pop(() => setOpen(false))}
        </div>
      </Popover>
    </>
  )
}
