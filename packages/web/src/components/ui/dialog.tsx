import { useEffect, useId, useRef, type ReactNode, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { portalTarget } from '../../lib/embed'
import { X } from 'lucide-react'
import { usePresence } from '../../lib/motion'
import './overlay.css'

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

/** Tab 在面板内循环；Esc 交给 onEscape。对话框与 ⌘K 共用。 */
export function trapKeys(e: ReactKeyboardEvent<HTMLElement>, onEscape: () => void) {
  if (e.key === 'Escape') {
    e.stopPropagation()
    e.preventDefault()
    onEscape()
    return
  }
  if (e.key !== 'Tab') return
  const nodes = [...e.currentTarget.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((n) => n.offsetParent !== null)
  if (!nodes.length) return
  const first = nodes[0]!
  const last = nodes[nodes.length - 1]!
  if (e.shiftKey && document.activeElement === first) {
    e.preventDefault()
    last.focus()
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault()
    first.focus()
  }
}

/** 打开时记下触发处，关闭（开始退出）时把焦点还回去。 */
export function useRestoreFocus(open: boolean) {
  const from = useRef<HTMLElement | null>(null)
  useEffect(() => {
    if (open) {
      from.current = document.activeElement as HTMLElement | null
      return
    }
    from.current?.focus?.()
    from.current = null
  }, [open])
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
  useRestoreFocus(open)

  useEffect(() => {
    if (!open || p.state !== 'enter') return
    // 首个可聚焦的输入优先，其次面板本身
    const el = panel.current
    const target = el?.querySelector<HTMLElement>('[data-autofocus]') ?? el?.querySelector<HTMLElement>('input, textarea, select') ?? el
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
    portalTarget(),
  )
}
