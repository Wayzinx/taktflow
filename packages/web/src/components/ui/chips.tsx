import { useState, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react'
import { Check, Plus, X, type LucideIcon } from 'lucide-react'
import { toneSoftVar, toneVar, type Tone } from '../../lib/status'
import './primitives.css'

export interface ChipItem {
  id: string
  label: ReactNode
  icon?: LucideIcon
  tone?: Tone
  /** 不可移除（例如必带的上下文）。 */
  fixed?: boolean
  title?: string
}

/**
 * 单个标签胶囊；给 onRemove 时末尾出现 ×（Backspace / Delete 也能移除）。
 *   <Chip icon={GitBranch} onRemove={() => drop('repo')}>shop-web</Chip>
 */
export function Chip({ children, icon: Icon, tone, onRemove, onClick, title, className }: { children: ReactNode; icon?: LucideIcon; tone?: Tone; onRemove?: () => void; onClick?: () => void; title?: string; className?: string }) {
  const style = tone ? ({ '--chip-fg': toneVar(tone), '--chip-bg': toneSoftVar(tone) } as CSSProperties) : undefined
  const onKey = (e: KeyboardEvent) => {
    if (onRemove && (e.key === 'Backspace' || e.key === 'Delete')) {
      e.preventDefault()
      onRemove()
    }
  }
  return (
    <span className={`ui-chip${onClick ? ' clickable pressable' : ''}${className ? ` ${className}` : ''}`} style={style} title={title} onClick={onClick} onKeyDown={onKey} tabIndex={onClick || onRemove ? 0 : undefined} role={onClick ? 'button' : undefined}>
      {Icon && <Icon className="ui-chip-icon" aria-hidden />}
      <span className="ui-chip-label truncate">{children}</span>
      {onRemove && (
        <button
          type="button"
          className="ui-chip-x"
          tabIndex={-1}
          aria-label="移除"
          onClick={(e) => {
            e.stopPropagation()
            onRemove()
          }}
        >
          <X aria-hidden />
        </button>
      )}
    </span>
  )
}

/**
 * 可移除的标签组（上下文标签、成员、intents）。移除时先播 120ms 退出再回调。
 *   <Chips items={ctx.map((c) => ({ id: c.id, label: c.label ?? c.id }))} onRemove={(id) => setCtx(ctx.filter((c) => c.id !== id))} onAdd={openPicker} addLabel="添加" />
 */
export function Chips({ items, onRemove, onAdd, addLabel = '添加', className }: { items: ChipItem[]; onRemove?: (id: string) => void; onAdd?: () => void; addLabel?: string; className?: string }) {
  const [leaving, setLeaving] = useState<Set<string>>(new Set())
  const remove = (id: string) => {
    setLeaving((s) => new Set(s).add(id))
    setTimeout(() => {
      setLeaving((s) => {
        const n = new Set(s)
        n.delete(id)
        return n
      })
      onRemove?.(id)
    }, 120)
  }
  return (
    <div className={`ui-chips${className ? ` ${className}` : ''}`}>
      {items.map((it) => (
        <Chip key={it.id} icon={it.icon} tone={it.tone} title={it.title} className={leaving.has(it.id) ? 'leaving' : undefined} onRemove={onRemove && !it.fixed ? () => remove(it.id) : undefined}>
          {it.label}
        </Chip>
      ))}
      {onAdd && (
        <button type="button" className="ui-chip ui-chip-add pressable" onClick={onAdd}>
          <Plus className="ui-chip-icon" aria-hidden />
          {addLabel}
        </button>
      )}
    </div>
  )
}

export interface ToggleOption {
  id: string
  label: ReactNode
  /** 悬停提示（例如技能的一句话说明）。 */
  title?: string
  /** 引用了但不存在：画成警示色，仍可点掉。 */
  missing?: boolean
}

/**
 * 多选标签（技能、知识库、渠道）：按下的带勾、强调色底；value 里有但 options 里没有的会补成"不存在"的标签，方便点掉。
 *   <ToggleChips ariaLabel="技能" options={skills.map((s) => ({ id: s.name, label: s.name, title: s.description }))} value={sel} onChange={setSel} />
 */
export function ToggleChips({ options, value, onChange, ariaLabel, mono, className }: { options: ToggleOption[]; value: string[]; onChange: (next: string[]) => void; ariaLabel: string; mono?: boolean; className?: string }) {
  const extra = value.filter((v) => !options.some((o) => o.id === v)).map((id): ToggleOption => ({ id, label: id, missing: true, title: '引用了但不存在' }))
  return (
    <div className={`ui-chips${className ? ` ${className}` : ''}`} role="group" aria-label={ariaLabel}>
      {[...options, ...extra].map((o) => {
        const on = value.includes(o.id)
        return (
          <button
            key={o.id}
            type="button"
            className={`ui-tchip pressable${mono ? ' mono' : ''}${o.missing ? ' missing' : ''}`}
            aria-pressed={on}
            title={o.title}
            onClick={() => onChange(on ? value.filter((v) => v !== o.id) : [...value, o.id])}
          >
            {on && <Check className="ui-chip-icon" aria-hidden />}
            {o.label}
          </button>
        )
      })}
    </div>
  )
}

/**
 * 自由输入的标签列表（glob、环境变量名）：回车或逗号添加，退格删最后一个；validate 返回错误文案时不加。
 *   <TagInput ariaLabel="写范围" value={scope} onChange={setScope} placeholder="src/**" mono validate={(v) => (v.startsWith('/') ? '用相对路径' : undefined)} />
 */
export function TagInput({ value, onChange, placeholder, ariaLabel, mono, validate }: { value: string[]; onChange: (next: string[]) => void; placeholder?: string; ariaLabel: string; mono?: boolean; validate?: (v: string) => string | undefined }) {
  const [text, setText] = useState('')
  const [error, setError] = useState<string>()
  const add = () => {
    const v = text.trim().replace(/,$/, '')
    if (!v) return
    const bad = validate?.(v) ?? (value.includes(v) ? '已经有了' : undefined)
    if (bad) return setError(bad)
    onChange([...value, v])
    setText('')
    setError(undefined)
  }
  return (
    <div className="ui-taginput">
      <div className={`ui-taginput-box${error ? ' is-bad' : ''}`}>
        {value.map((v) => (
          <Chip key={v} className={mono ? 'mono' : undefined} onRemove={() => onChange(value.filter((x) => x !== v))}>
            {v}
          </Chip>
        ))}
        <input
          className={`ui-taginput-input${mono ? ' mono' : ''}`}
          value={text}
          placeholder={value.length ? '' : placeholder}
          aria-label={ariaLabel}
          aria-invalid={!!error}
          onChange={(e) => {
            setText(e.target.value)
            setError(undefined)
            if (e.target.value.endsWith(',')) queueMicrotask(add)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              add()
            } else if (e.key === 'Backspace' && !text && value.length) onChange(value.slice(0, -1))
          }}
          onBlur={add}
        />
      </div>
      {error && <span className="ui-taginput-err" role="alert">{error}</span>}
    </div>
  )
}
