import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import { Check, type LucideIcon } from 'lucide-react'
import { Popover, type Placement } from './popover'
import './overlay.css'

export interface MenuItem {
  id: string
  label: ReactNode
  icon?: LucideIcon
  hint?: ReactNode
  /** 单选菜单里的当前项 */
  checked?: boolean
  danger?: boolean
  disabled?: boolean
  /** 这一项之前画一条分隔线 */
  separator?: boolean
  /** 这一项之前的分组标题 */
  section?: string
  /** 首字母跳转用的纯文本（label 不是字符串时给） */
  text?: string
  onSelect: () => void
}

/**
 * 下拉菜单：走 Popover 浮层原语（门户、翻转、进 150 / 出 120ms）。
 * 键盘：↑↓ 选择（跳过禁用项）、Home / End、输入首字母跳转、↵ / 空格执行、Esc 关闭并把焦点还给触发按钮。
 *   const btn = useRef<HTMLButtonElement>(null); const [open, setOpen] = useState(false)
 *   <button ref={btn} onClick={() => setOpen(true)}>更多</button>
 *   <Menu open={open} onClose={() => setOpen(false)} anchor={btn} items={[{ id: 'archive', label: '归档', icon: Archive, onSelect: archive }, { id: 'del', label: '删除', danger: true, separator: true, onSelect: del }]} />
 */
export function Menu({ open, onClose, anchor, items, placement = 'bottom-start', ariaLabel, minWidth = 180 }: { open: boolean; onClose: () => void; anchor: RefObject<HTMLElement | null>; items: MenuItem[]; placement?: Placement; ariaLabel?: string; minWidth?: number }) {
  const [sel, setSel] = useState(-1)
  const list = useRef<HTMLDivElement>(null)
  const typed = useRef({ text: '', at: 0 })
  useEffect(() => {
    if (!open) return
    setSel(Math.max(0, items.findIndex((i) => i.checked && !i.disabled)))
    const t = setTimeout(() => list.current?.focus({ preventScroll: true }))
    return () => clearTimeout(t)
    // 只在打开时定位初始选中项
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])
  useEffect(() => {
    list.current?.querySelector(`#ov-mi-${sel}`)?.scrollIntoView({ block: 'nearest' })
  }, [sel])

  const pick = (it: MenuItem | undefined) => {
    if (!it || it.disabled) return
    onClose()
    anchor.current?.focus?.()
    it.onSelect()
  }
  const enabled = (i: number) => !!items[i] && !items[i]!.disabled
  const move = (d: 1 | -1) => {
    if (!items.length) return
    let i = sel
    for (let n = 0; n < items.length; n++) {
      i = (i + d + items.length) % items.length
      if (enabled(i)) break
    }
    setSel(i)
  }
  const edge = (end: boolean) => {
    const order = items.map((_, i) => i)
    const i = (end ? order.reverse() : order).find(enabled)
    if (i !== undefined) setSel(i)
  }
  const jump = (ch: string) => {
    const now = Date.now()
    typed.current = { text: now - typed.current.at > 600 ? ch : typed.current.text + ch, at: now }
    const q = typed.current.text.toLowerCase()
    const i = items.findIndex((it, idx) => enabled(idx) && (it.text ?? (typeof it.label === 'string' ? it.label : '')).toLowerCase().startsWith(q))
    if (i >= 0) setSel(i)
  }

  return (
    <Popover open={open} onClose={onClose} anchor={anchor} placement={placement} className="ov-menu" role="menu" ariaLabel={ariaLabel}>
      <div
        ref={list}
        tabIndex={-1}
        className="ov-menu-list"
        style={{ minWidth }}
        aria-activedescendant={sel >= 0 ? `ov-mi-${sel}` : undefined}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') move(1)
          else if (e.key === 'ArrowUp') move(-1)
          else if (e.key === 'Home') edge(false)
          else if (e.key === 'End') edge(true)
          else if (e.key === 'Enter' || e.key === ' ') pick(items[sel])
          else if (e.key === 'Tab') onClose()
          else if (e.key.length === 1 && !e.metaKey && !e.ctrlKey) jump(e.key)
          else return
          if (e.key !== 'Tab') e.preventDefault()
        }}
      >
        {items.map((it, i) => {
          const Icon = it.icon
          return (
            <div key={it.id} role="presentation">
              {it.separator && i > 0 && <div className="ov-mi-sep" role="separator" />}
              {it.section && <div className="ov-mi-section">{it.section}</div>}
              <div
                id={`ov-mi-${i}`}
                role={it.checked === undefined ? 'menuitem' : 'menuitemradio'}
                aria-checked={it.checked}
                aria-disabled={it.disabled || undefined}
                className={`ov-mi${i === sel ? ' on' : ''}${it.danger ? ' danger' : ''}${it.disabled ? ' disabled' : ''}`}
                onMouseMove={() => i !== sel && !it.disabled && setSel(i)}
                onClick={() => pick(it)}
              >
                {Icon ? <Icon className="ov-mi-icon" aria-hidden /> : it.checked !== undefined ? <span className="ov-mi-icon" /> : null}
                <span className="ov-mi-label truncate">{it.label}</span>
                {it.hint && <span className="ov-mi-hint">{it.hint}</span>}
                {it.checked && <Check className="ov-mi-check" aria-hidden />}
              </div>
            </div>
          )
        })}
      </div>
    </Popover>
  )
}
