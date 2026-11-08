import type { CSSProperties, ReactNode } from 'react'
import { Check } from 'lucide-react'
import { toneVar, type Tone } from '../../lib/status'

export interface BarItem {
  key: string
  label: ReactNode
  value: number
  /** 缺省取本组最大值。 */
  max?: number
  tone?: Tone
  /** 右侧读数；缺省显示 value。 */
  display?: ReactNode
  hint?: string
  onClick?: () => void
}

/** 横向条形：一行一项，条长 = value / max，用 scaleX 从 0 长到值（入场一次）。 */
export function Bars({ items, className }: { items: BarItem[]; className?: string }) {
  const max = Math.max(1e-9, ...items.map((i) => i.max ?? i.value))
  return (
    <ul className={`bars${className ? ` ${className}` : ''}`}>
      {items.map((b, i) => {
        const p = Math.max(0, Math.min(1, b.value / (b.max ?? max)))
        const Row = b.onClick ? 'button' : 'div'
        return (
          <li key={b.key} style={{ '--i': i } as CSSProperties}>
            <Row {...(b.onClick ? { type: 'button' as const, onClick: b.onClick } : {})} className={`bar-row${b.onClick ? ' bar-click' : ''}`} title={b.hint}>
              <span className="bar-label truncate">{b.label}</span>
              <span className="bar-track">
                <span className="bar-fill" style={{ '--p': p, '--bar-tone': b.tone ? toneVar(b.tone) : 'var(--c-1)' } as CSSProperties} />
              </span>
              <span className="bar-value num">{b.display ?? b.value}</span>
            </Row>
          </li>
        )
      })}
    </ul>
  )
}

export interface CheckItem {
  key: string
  label: ReactNode
  done: boolean
  hint?: ReactNode
  onClick?: () => void
}

/** 只读清单：完成打勾、未完成空心圈；可点的项跳到对象。 */
export function Checklist({ items, className }: { items: CheckItem[]; className?: string }) {
  const done = items.filter((i) => i.done).length
  return (
    <div className={`checklist${className ? ` ${className}` : ''}`}>
      <div className="checklist-meter" role="img" aria-label={`${done}/${items.length} 完成`}>
        <span style={{ '--p': items.length ? done / items.length : 0 } as CSSProperties} />
      </div>
      <ul>
        {items.map((c, i) => {
          const Row = c.onClick ? 'button' : 'div'
          return (
            <li key={c.key} style={{ '--i': i } as CSSProperties}>
              <Row {...(c.onClick ? { type: 'button' as const, onClick: c.onClick } : {})} className={`check-row${c.onClick ? ' check-click' : ''}`} data-done={c.done || undefined}>
                <span className="check-box" aria-label={c.done ? '已完成' : '未完成'}>{c.done && <Check strokeWidth={3} />}</span>
                <span className="check-body">
                  <span className="check-label">{c.label}</span>
                  {c.hint && <span className="check-hint">{c.hint}</span>}
                </span>
              </Row>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

export interface TimelineItem {
  key: string
  at: ReactNode
  title: ReactNode
  detail?: ReactNode
  tone?: Tone
  onClick?: () => void
}

/** 竖向时间线：圆点 + 细线，最新在上。 */
export function Timeline({ items, className }: { items: TimelineItem[]; className?: string }) {
  return (
    <ol className={`timeline${className ? ` ${className}` : ''}`}>
      {items.map((t, i) => {
        const Row = t.onClick ? 'button' : 'div'
        return (
          <li key={t.key} style={{ '--i': i, '--dot': t.tone ? toneVar(t.tone) : 'var(--text-3)' } as CSSProperties}>
            <span className="tl-dot" aria-hidden />
            <Row {...(t.onClick ? { type: 'button' as const, onClick: t.onClick } : {})} className={`tl-body${t.onClick ? ' tl-click' : ''}`}>
              <span className="tl-head">
                <span className="tl-title">{t.title}</span>
                <span className="tl-at num">{t.at}</span>
              </span>
              {t.detail && <span className="tl-detail">{t.detail}</span>}
            </Row>
          </li>
        )
      })}
    </ol>
  )
}
