import { useEffect, useId, useRef, type ReactNode, type RefObject, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'
import { usePresence } from '../../lib/motion'
import './overlay.css'

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

const focusables = (el: HTMLElement) => [...el.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((n) => n.offsetParent !== null)

/** Tab 在面板内循环；Esc 交给 onEscape。对话框与 ⌘K 共用。 */
export function trapKeys(e: ReactKeyboardEvent<HTMLElement>, onEscape: () => void) {
  if (e.key === 'Escape') {
    e.stopPropagation()
    e.preventDefault()
    onEscape()
    return
  }
  if (e.key !== 'Tab') return
  const nodes = focusables(e.currentTarget)
  if (!nodes.length) {
    e.preventDefault()
    e.currentTarget.focus()
    return
  }
  const first = nodes[0]!
  const last = nodes[nodes.length - 1]!
  if (e.shiftKey && (document.activeElement === first || document.activeElement === e.currentTarget)) {
    e.preventDefault()
    last.focus()
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault()
    first.focus()
  }
}

const lost = () => !document.activeElement || document.activeElement === document.body || document.activeElement === document.documentElement

/** 打开着的模态浮层，后开的在上面：焦点丢失时只有最上面那个接管按键。 */
const modals: Array<RefObject<HTMLElement | null>> = []

/**
 * 焦点掉到 body 上时（例如获得焦点的按钮被禁用、被移除）面板自己的 onKeyDown 收不到按键：
 * 在 document 上兜底，最上层的模态浮层仍能 Esc 关闭，Tab 把焦点拉回面板里；菜单已处理的按键不重复接管。
 */
export function useModalKeys(open: boolean, panel: RefObject<HTMLElement | null>, onEscape: () => void) {
  const escape = useRef(onEscape)
  escape.current = onEscape
  useEffect(() => {
    if (!open) return
    modals.push(panel)
    const onKey = (e: KeyboardEvent) => {
      const el = panel.current
      if (e.defaultPrevented || modals[modals.length - 1] !== panel || !el || el.contains(document.activeElement)) return
      if (e.key === 'Escape') {
        e.preventDefault()
        escape.current()
      } else if (e.key === 'Tab') {
        e.preventDefault()
        const nodes = focusables(el)
        ;((e.shiftKey ? nodes[nodes.length - 1] : nodes[0]) ?? el).focus()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('keydown', onKey)
      modals.splice(modals.indexOf(panel), 1)
    }
  }, [open, panel])
}

/**
 * 打开时记下触发处，关闭（开始退出）时把焦点还回去。
 * 在"变成打开"的那次渲染里记：浮层还没挂载，子组件的 autoFocus / effect 还没把焦点抢进浮层（在 effect 里记会记成浮层里的输入框）。
 * 关闭时焦点已经被用户移到浮层外别处就不抢；触发处已不在页面上（换页、列表重绘）时退回正文区域，不让焦点掉到 body。
 */
export function useRestoreFocus(open: boolean, panel?: RefObject<HTMLElement | null>) {
  const from = useRef<HTMLElement | null | undefined>(undefined)
  const wasOpen = useRef(false)
  if (open && !wasOpen.current) from.current = lost() ? null : (document.activeElement as HTMLElement)
  wasOpen.current = open
  useEffect(() => {
    if (open || from.current === undefined) return
    const el = from.current
    from.current = undefined
    const active = document.activeElement
    if (!lost() && panel?.current && active && !panel.current.contains(active)) return
    if (el?.isConnected) el.focus({ preventScroll: true })
    else if (el) document.getElementById('main')?.focus({ preventScroll: true })
  }, [open, panel])
}

export interface DialogProps {
  open: boolean
  onClose: () => void
  title: ReactNode
  /** 标题下的一行说明 */
  description?: ReactNode
  children?: ReactNode
  /** 底部操作区（按钮靠右） */
  footer?: ReactNode
  size?: 'sm' | 'md' | 'lg'
  /** 危险操作：标题前加失败色刻度 */
  tone?: 'default' | 'danger'
  /** 点遮罩不关闭（表单填了一半时） */
  dismissible?: boolean
  className?: string
}

/**
 * 模态对话框：门户到 body，遮罩 + 面板都有进出场（200ms 进 / 150ms 出），
 * 退出期间保留最后一帧；Esc / 遮罩关闭；Tab 不出面板；关闭后焦点回到触发处。
 */
export function Dialog({ open, onClose, title, description, children, footer, size = 'md', tone = 'default', dismissible = true, className }: DialogProps) {
  const p = usePresence(open, 150)
  const titleId = useId()
  const descId = useId()
  const panel = useRef<HTMLDivElement>(null)
  useRestoreFocus(open, panel)
  useModalKeys(open, panel, onClose)

  useEffect(() => {
    if (!open || p.state !== 'enter') return
    // 首个可聚焦的输入优先，其次面板本身
    const el = panel.current
    const target = el?.querySelector<HTMLElement>('[data-autofocus], input, textarea, select') ?? el
    target?.focus({ preventScroll: true })
  }, [open, p.state])

  if (!p.mounted) return null
  return createPortal(
    <div className="ov-scrim presence-scrim" data-state={p.state} onMouseDown={dismissible ? onClose : undefined}>
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descId : undefined}
        tabIndex={-1}
        className={`ov-dialog ov-${size} presence-dialog${tone === 'danger' ? ' ov-danger' : ''}${className ? ` ${className}` : ''}`}
        data-state={p.state}
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => trapKeys(e, onClose)}
      >
        <header className="ov-head">
          <div className="ov-head-text">
            <h2 id={titleId} className="ov-title">
              {title}
            </h2>
            {description && (
              <p id={descId} className="ov-desc">
                {description}
              </p>
            )}
          </div>
          <button type="button" className="btn btn-ghost btn-icon btn-sm" onClick={onClose} aria-label="关闭" title="关闭（Esc）">
            <X />
          </button>
        </header>
        {children !== undefined && <div className="ov-body">{children}</div>}
        {footer && <footer className="ov-foot">{footer}</footer>}
      </div>
    </div>,
    document.body,
  )
}
