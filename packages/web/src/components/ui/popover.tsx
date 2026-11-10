import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'
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

function place(a: DOMRect, el: HTMLElement | null, placement: Placement, offset: number, matchWidth: boolean): Pos {
  const w = el?.offsetWidth ?? 0
  const h = el?.offsetHeight ?? 0
  const vw = window.innerWidth
  const vh = window.innerHeight
  let top = placement.startsWith('top')
  const above = a.top - offset - 8
  const below = vh - 8 - a.bottom - offset
  // 放不下就翻到另一侧；两侧都放不下时放到空间大的一侧
  if (!top && h > below && (h <= above || above > below)) top = true
  else if (top && h > above && (h <= below || below > above)) top = false
  const end = placement.endsWith('end')
  let left = end ? a.right - w : a.left
  left = Math.max(8, Math.min(left, vw - w - 8))
  // 还是放不下（比视口还高）时贴着视口边，不超出屏幕
  const y = Math.max(8, Math.min(top ? a.top - offset - h : a.bottom + offset, vh - h - 8))
  return { top: y, left, minWidth: matchWidth ? a.width : undefined, flip: top }
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
    // 内容在打开后才加载出来（列表、模型目录），面板变高了要重新定位，否则会顶出屏幕
    const ro = typeof ResizeObserver !== 'undefined' && ref.current ? new ResizeObserver(update) : undefined
    if (ro && ref.current) ro.observe(ref.current)
    return () => {
      window.removeEventListener('resize', update)
      window.removeEventListener('scroll', update, true)
      ro?.disconnect()
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
    document.body,
  )
}

// 下拉菜单见 ./menu.tsx（Menu / MenuItem）
