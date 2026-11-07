import { useState, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react'
import { Plus, X, type LucideIcon } from 'lucide-react'
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
