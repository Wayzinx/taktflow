import type { CSSProperties, ReactNode } from 'react'
import { toneVar, type Tone } from '../../lib/status'

export interface Tile {
  key: string
  label: string
  value: ReactNode
  unit?: ReactNode
  /** 只在数字表达状态时给：数字着色。 */
  tone?: Tone
  hint?: ReactNode
  icon?: ReactNode
  /** 数字下方的小图（占比条、迷你泳道）。 */
  children?: ReactNode
  onClick?: () => void
  active?: boolean
  title?: string
}

/**
 * 读数格：小标签、大数字（有状态才着色）、一行注释。
 * 列数按容器宽度：宽 = 全部一行；中 = ceil(n/2) 列；窄 = 至多 3 列；极窄 = 2 列。
 * 最后一行的格子自动撑满（flex-grow），不会单独一格挂在下一行左边。
 */
export function StatTiles({ tiles, label, className }: { tiles: Tile[]; label: string; className?: string }) {
  const n = tiles.length
  return (
    <section className={`tiles${className ? ` ${className}` : ''}`} aria-label={label} style={{ '--n': n, '--n-md': Math.ceil(n / 2), '--n-sm': n <= 3 ? n : n === 4 ? 2 : 3 } as CSSProperties}>
      {tiles.map((t, i) => {
        const body = (
          <>
            <span className="tile-label">
              {t.icon}
              {t.label}
            </span>
            <span className="tile-value num">
              {t.value}
              {t.unit && <span className="tile-unit">{t.unit}</span>}
            </span>
            {t.children}
            {t.hint && <span className="tile-hint">{t.hint}</span>}
          </>
        )
        const style = { '--i': i, ...(t.tone ? { '--tile-tone': toneVar(t.tone) } : {}) } as CSSProperties
        const cls = `tile${t.tone ? ' toned' : ''}${t.onClick ? ' tile-click pressable' : ''}`
        return t.onClick ? (
          <button key={t.key} type="button" className={cls} style={style} onClick={t.onClick} aria-pressed={t.active} title={t.title}>
            {body}
          </button>
        ) : (
          <div key={t.key} className={cls} style={style} title={t.title}>
            {body}
          </div>
        )
      })}
    </section>
  )
}
