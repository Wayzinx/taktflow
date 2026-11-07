import { useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react'
import type { LucideIcon } from 'lucide-react'
import './primitives.css'

export interface SegmentedOption<T extends string> {
  value: T
  label: string
  icon?: LucideIcon
  count?: number
  disabled?: boolean
}

/**
 * 分段选择：选中块用 transform 平移（150ms），←→ 切换，role=radiogroup。
 *   <Segmented value={view} onChange={setView} options={[{ value: 'grid', label: '卡片' }, { value: 'list', label: '列表' }]} />
 */
export function Segmented<T extends string>({ options, value, onChange, size, ariaLabel, className }: { options: Array<SegmentedOption<T>>; value: T; onChange: (v: T) => void; size?: 'sm'; ariaLabel?: string; className?: string }) {
  const root = useRef<HTMLDivElement>(null)
  const [thumb, setThumb] = useState<{ x: number; w: number } | null>(null)
  useLayoutEffect(() => {
    const el = root.current?.querySelector<HTMLElement>('[aria-checked="true"]')
    if (!el) return setThumb(null)
    const next = { x: el.offsetLeft, w: el.offsetWidth }
    setThumb((t) => (t && t.x === next.x && t.w === next.w ? t : next))
  })
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
    e.preventDefault()
    const live = options.filter((o) => !o.disabled)
    const i = live.findIndex((o) => o.value === value)
    const next = live[(i + (e.key === 'ArrowRight' ? 1 : -1) + live.length) % live.length]
    if (next) {
      onChange(next.value)
      requestAnimationFrame(() => root.current?.querySelector<HTMLElement>('[aria-checked="true"]')?.focus())
    }
  }
  return (
    <div ref={root} className={`segmented${size === 'sm' ? ' segmented-sm' : ''}${className ? ` ${className}` : ''}`} role="radiogroup" aria-label={ariaLabel} onKeyDown={onKey}>
      {thumb && <span className="segmented-thumb" aria-hidden style={{ width: thumb.w, '--seg-x': `${thumb.x}px` } as CSSProperties} />}
      {options.map((o) => {
        const on = o.value === value
        const Icon = o.icon
        return (
          <button key={o.value} type="button" role="radio" aria-checked={on} tabIndex={on ? 0 : -1} disabled={o.disabled} className={on ? 'on' : undefined} onClick={() => onChange(o.value)}>
            {Icon && <Icon aria-hidden />}
            {o.label}
            {o.count !== undefined && <span className="segmented-count num">{o.count}</span>}
          </button>
        )
      })}
    </div>
  )
}
