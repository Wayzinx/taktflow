import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { usePresence } from '../../lib/motion'
import './overlay.css'

/**
 * 悬停卡（docs/design/30 §2）：指针停在参照上 400ms 才出现，移到卡片上不消失，离开 120ms 后收起；
 * 放在参照右侧（放不下换左侧），不抢焦点、不拦点击。只放补充信息，操作仍在参照本身或它的菜单里。
 *   const hc = useHoverCard<HTMLLIElement>()
 *   <li ref={hc.ref} {...hc.bind}>…</li>
 *   <HoverCard {...hc.card}>标题、所在空间、更新时间…</HoverCard>
 */
export function useHoverCard<T extends HTMLElement>(delay = 400) {
  const ref = useRef<T>(null)
  const [open, setOpen] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const openRef = useRef(open)
  openRef.current = open
  useEffect(() => () => clearTimeout(timer.current), [])
  const enter = () => {
    clearTimeout(timer.current)
    timer.current = setTimeout(() => setOpen(true), openRef.current ? 0 : delay)
  }
  const leave = () => {
    clearTimeout(timer.current)
    timer.current = setTimeout(() => setOpen(false), 120)
  }
  const close = () => {
    clearTimeout(timer.current)
    setOpen(false)
  }
  return { ref, open, close, bind: { onMouseEnter: enter, onMouseLeave: leave, onMouseDown: close }, card: { open, anchor: ref, onMouseEnter: enter, onMouseLeave: leave } }
}

export function HoverCard({ open, anchor, onMouseEnter, onMouseLeave, children, className }: { open: boolean; anchor: RefObject<HTMLElement | null>; onMouseEnter: () => void; onMouseLeave: () => void; children: ReactNode; className?: string }) {
  const p = usePresence(open, 120)
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ top: number; left: number; side: 'right' | 'left' } | null>(null)
  useLayoutEffect(() => {
    if (!p.mounted || !open) return
    const a = anchor.current?.getBoundingClientRect()
    const el = ref.current
    if (!a || !el) return
    const w = el.offsetWidth
    const h = el.offsetHeight
    const right = a.right + 8 + w <= window.innerWidth - 8
    setPos({ side: right ? 'right' : 'left', left: right ? a.right + 8 : Math.max(8, a.left - 8 - w), top: Math.max(8, Math.min(a.top, window.innerHeight - h - 8)) })
  }, [p.mounted, open, anchor])
  if (!p.mounted) return null
  const style = { top: pos?.top ?? -9999, left: pos?.left ?? -9999, '--pop-dx': pos?.side === 'left' ? '4px' : '-4px', '--pop-dy': '0px', transformOrigin: `${pos?.side === 'left' ? 'right' : 'left'} top` } as CSSProperties
  return createPortal(
    <div ref={ref} className={`ov-pop ov-hovercard presence-pop${className ? ` ${className}` : ''}`} data-state={pos ? p.state : 'enter'} style={style} role="tooltip" onMouseEnter={onMouseEnter} onMouseLeave={onMouseLeave}>
      {children}
    </div>,
    document.body,
  )
}
