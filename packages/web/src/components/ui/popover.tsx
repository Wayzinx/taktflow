import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { portalTarget } from '../../lib/embed'
import { Check, type LucideIcon } from 'lucide-react'
import { usePresence } from '../../lib/motion'
import './overlay.css'

export type Placement = 'bottom-start' | 'bottom-end' | 'top-start' | 'top-end'

export interface PopoverProps {
  open: boolean
  onClose: () => void
  /** 定位参照（通常是触发按钮） */
  anchor: RefObject<HTMLElement | null>
  placement?: Placement
  /** 与参照的间距，默认 6px */
  offset?: number
  /** 最小宽度跟参照一致（下拉选择用） */
  matchWidth?: boolean
  children: ReactNode
  className?: string
  role?: string
  ariaLabel?: string
}

interface Pos {
  top: number
  left: number
  minWidth?: number
  flip: boolean
}

/** 弹层的定位区域：挂在 body 时是视口；嵌入时挂在嵌入根（size 容器，fixed 相对它定位）。 */
function frame(): { x: number; y: number; w: number; h: number } {
  const root = portalTarget()
  if (root === document.body) return { x: 0, y: 0, w: window.innerWidth, h: window.innerHeight }
  const r = root.getBoundingClientRect()
  return { x: r.left, y: r.top, w: r.width, h: r.height }
}

function place(anchorRect: DOMRect, el: HTMLElement | null, placement: Placement, offset: number, matchWidth: boolean): Pos {
  const f = frame()
  const a = { top: anchorRect.top - f.y, bottom: anchorRect.bottom - f.y, left: anchorRect.left - f.x, right: anchorRect.right - f.x, width: anchorRect.width }
  const w = el?.offsetWidth ?? 0
  const h = el?.offsetHeight ?? 0
  const vw = f.w
  const vh = f.h
  let top = placement.startsWith('top')
  // 放不下就翻到另一侧
  if (!top && a.bottom + offset + h > vh - 8 && a.top - offset - h > 8) top = true
  else if (top && a.top - offset - h < 8 && a.bottom + offset + h < vh - 8) top = false
  const end = placement.endsWith('end')
  let left = end ? a.right - w : a.left
  left = Math.max(8, Math.min(left, vw - w - 8))
  return { top: top ? a.top - offset - h : a.bottom + offset, left, minWidth: matchWidth ? a.width : undefined, flip: top }
}

/**
 * 气泡 / 下拉面板：门户到 body、fixed 定位跟随参照（滚动 / 缩放时重算），放不下自动翻转；
 * 进 150ms / 出 120ms（.presence-pop），Esc 与点外部关闭。
 */
export function Popover({ open, onClose, anchor, placement = 'bottom-start', offset = 6, matchWidth, children, className, role, ariaLabel }: PopoverProps) {
  const p = usePresence(open, 120)
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<Pos | null>(null)

  useLayoutEffect(() => {
    if (!p.mounted) return
    const update = () => {
      const a = anchor.current?.getBoundingClientRect()
      if (a) setPos(place(a, ref.current, placement, offset, !!matchWidth))
    }
    update()
    // 退出动画期间不再跟随，避免从参照处"滑走"
    if (!open) return
    window.addEventListener('resize', update)
    window.addEventListener('scroll', update, true)
    return () => {
      window.removeEventListener('resize', update)
      window.removeEventListener('scroll', update, true)
    }
  }, [p.mounted, open, anchor, placement, offset, matchWidth])

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node
      if (ref.current?.contains(t) || anchor.current?.contains(t)) return
      onClose()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      onClose()
      anchor.current?.focus?.()
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey, true)
    }
  }, [open, onClose, anchor])

  if (!p.mounted) return null
  const style = {
    top: pos?.top ?? -9999,
    left: pos?.left ?? -9999,
    minWidth: pos?.minWidth,
    '--pop-dy': pos?.flip ? '4px' : '-4px',
    transformOrigin: `${placement.endsWith('end') ? 'right' : 'left'} ${pos?.flip ? 'bottom' : 'top'}`,
  } as CSSProperties
  return createPortal(
    <div ref={ref} className={`ov-pop presence-pop${className ? ` ${className}` : ''}`} data-state={pos ? p.state : 'enter'} style={style} role={role} aria-label={ariaLabel}>
      {children}
    </div>,
    portalTarget(),
  )
}

// ---------------------------------------------------------------- 下拉菜单

export interface MenuItem {
  id: string
  label: ReactNode
  icon?: LucideIcon
  hint?: ReactNode
  /** 单选菜单里的当前项 */
  checked?: boolean
  danger?: boolean
  disabled?: boolean
  onSelect: () => void
}

/** 下拉菜单：↑↓ 选择、↵ 执行、Esc 关闭并把焦点还给触发按钮。 */
export function Menu({ open, onClose, anchor, items, placement = 'bottom-start', ariaLabel }: { open: boolean; onClose: () => void; anchor: RefObject<HTMLElement | null>; items: MenuItem[]; placement?: Placement; ariaLabel?: string }) {
  const [sel, setSel] = useState(-1)
  const list = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    setSel(Math.max(0, items.findIndex((i) => i.checked && !i.disabled)))
    const t = setTimeout(() => list.current?.focus({ preventScroll: true }))
    return () => clearTimeout(t)
    // 只在打开时定位初始选中项
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const pick = (it: MenuItem | undefined) => {
    if (!it || it.disabled) return
    onClose()
    anchor.current?.focus?.()
    it.onSelect()
  }
  const move = (d: 1 | -1) => {
    if (!items.length) return
    let i = sel
    for (let n = 0; n < items.length; n++) {
      i = (i + d + items.length) % items.length
      if (!items[i]!.disabled) break
    }
    setSel(i)
  }

  return (
    <Popover open={open} onClose={onClose} anchor={anchor} placement={placement} className="ov-menu" role="menu" ariaLabel={ariaLabel}>
      <div
        ref={list}
        tabIndex={-1}
        className="ov-menu-list"
        aria-activedescendant={sel >= 0 ? `ov-mi-${sel}` : undefined}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') move(1)
          else if (e.key === 'ArrowUp') move(-1)
          else if (e.key === 'Enter' || e.key === ' ') pick(items[sel])
          else return
          e.preventDefault()
        }}
      >
        {items.map((it, i) => {
          const Icon = it.icon
          return (
            <div
              key={it.id}
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
          )
        })}
      </div>
    </Popover>
  )
}
