import { useRef, useState, type ReactNode } from 'react'
import { X, type LucideIcon } from 'lucide-react'
import { Popover, type Placement } from '../ui'
import './tags.css'

/**
 * 对话框下方标签行的一枚标签：没值时是"+ 仓库"这类虚线入口，有值时显示值，可一键清掉；点开是浮层表单。
 * 浮层走 components/ui 的 Popover（门户、翻转、Esc、点外部关闭、退出动画）。
 */
export function Tag({
  icon: Icon,
  label,
  value,
  onClear,
  children,
  width = 300,
  placement = 'top-start',
  title,
  live,
}: {
  icon: LucideIcon
  label: string
  /** 有值时显示的内容 */
  value?: ReactNode
  onClear?: () => void
  /** 浮层内容；拿到 close 便于选完即关 */
  children: (close: () => void) => ReactNode
  width?: number
  placement?: Placement
  title?: string
  /** 值在变化中（例如路由预估还没停下） */
  live?: boolean
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLButtonElement>(null)
  const close = () => setOpen(false)
  const set = value !== undefined && value !== null && value !== false
  return (
    <span className={`rc-tag${set ? ' set' : ''}${open ? ' open' : ''}`}>
      <button ref={ref} type="button" className="rc-tag-btn" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen((o) => !o)} title={title ?? label}>
        <Icon aria-hidden />
        {set ? <span className={`rc-tag-value${live ? ' shimmer-text' : ''}`}>{value}</span> : <span className="rc-tag-label">{label}</span>}
      </button>
      {set && onClear && (
        <button type="button" className="rc-tag-x" aria-label={`清除${label}`} title={`清除${label}`} onClick={onClear}>
          <X aria-hidden />
        </button>
      )}
      <Popover open={open} onClose={close} anchor={ref} placement={placement} className="rc-pop" ariaLabel={label} role="dialog">
        <div className="rc-pop-inner" style={{ width }}>
          <div className="rc-pop-title">{label}</div>
          {children(close)}
        </div>
      </Popover>
    </span>
  )
}

/** 浮层里的勾选列表行（仓库、成员） */
export function CheckRow({ checked, onChange, children, hint, radio }: { checked: boolean; onChange: (v: boolean) => void; children: ReactNode; hint?: ReactNode; radio?: boolean }) {
  return (
    <label className="rc-check pressable">
      <input type={radio ? 'radio' : 'checkbox'} checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span className="rc-check-main truncate">{children}</span>
      {hint && <span className="rc-check-hint">{hint}</span>}
    </label>
  )
}
