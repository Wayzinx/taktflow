import { useEffect, useId, useRef, type CSSProperties, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'
import { usePresence } from '../../lib/motion'
import { trapKeys, useModalKeys, useRestoreFocus } from './dialog'
import './primitives.css'

export interface DrawerProps {
  open: boolean
  onClose: () => void
  title?: ReactNode
  /** 标题下一行说明 */
  description?: ReactNode
  /** 标题右侧的按钮（在关闭按钮之前） */
  headerActions?: ReactNode
  children?: ReactNode
  footer?: ReactNode
  /** 宽度，默认 440px（窄屏占满） */
  width?: number
  /**
   * modal：带遮罩、Tab 不出面板（设置抽屉、产品健康）；
   * dock：不带遮罩、不抢焦点循环，页面仍可操作（管家停靠面板）。默认 modal。
   */
  mode?: 'modal' | 'dock'
  className?: string
  ariaLabel?: string
}

/**
 * 右侧抽屉 / 停靠面板底座：translateX(16px) + 淡入 220ms 进，160ms 出（usePresence 保留退出帧，重开可打断）；
 * Esc 关闭，关闭后焦点回到触发处；reduced-motion 下只淡入淡出。
 *   <Drawer open={open} onClose={close} title="产品健康" width={520}>…</Drawer>
 *   <Drawer mode="dock" open={dock.open} onClose={closeSteward} title="管家" headerActions={…}>…</Drawer>
 */
export function Drawer({ open, onClose, title, description, headerActions, children, footer, width = 440, mode = 'modal', className, ariaLabel }: DrawerProps) {
  const p = usePresence(open, 160)
  const panel = useRef<HTMLDivElement>(null)
  const titleId = useId()
  useRestoreFocus(open, panel)
  useModalKeys(open && mode === 'modal', panel, onClose)

  useEffect(() => {
    if (!open || p.state !== 'enter') return
    const el = panel.current
    const target = el?.querySelector<HTMLElement>('[data-autofocus]') ?? el
    target?.focus({ preventScroll: true })
  }, [open, p.state])

  // dock 模式没有遮罩：Esc 在面板外也能关
  useEffect(() => {
    if (!open || mode !== 'dock') return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !document.querySelector('[role="dialog"][aria-modal="true"]')) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, mode, onClose])

  if (!p.mounted) return null
  const body = (
    <div
      ref={panel}
      role="dialog"
      aria-modal={mode === 'modal' ? 'true' : undefined}
      aria-labelledby={title ? titleId : undefined}
      aria-label={title ? undefined : ariaLabel}
      tabIndex={-1}
      className={`ui-drawer ui-drawer-${mode}${className ? ` ${className}` : ''}`}
      data-state={p.state}
      style={{ '--drawer-w': `${width}px` } as CSSProperties}
      onMouseDown={(e) => e.stopPropagation()}
      onKeyDown={mode === 'modal' ? (e) => trapKeys(e, onClose) : undefined}
    >
      {(title || headerActions) && (
        <header className="ui-drawer-head">
          <div className="ui-drawer-head-text">
            {title && (
              <h2 id={titleId} className="ui-drawer-title">
                {title}
              </h2>
            )}
            {description && <p className="ui-drawer-desc">{description}</p>}
          </div>
          {headerActions}
          <button type="button" className="btn btn-ghost btn-icon btn-sm" onClick={onClose} aria-label="关闭" title="关闭（Esc）">
            <X />
          </button>
        </header>
      )}
      <div className="ui-drawer-body">{children}</div>
      {footer && <footer className="ui-drawer-foot">{footer}</footer>}
    </div>
  )
  return createPortal(
    mode === 'modal' ? (
      <div className="ui-drawer-scrim presence-scrim" data-state={p.state} onMouseDown={onClose}>
        {body}
      </div>
    ) : (
      body
    ),
    document.body,
  )
}
