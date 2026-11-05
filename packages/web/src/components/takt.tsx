import type { CSSProperties, ReactNode } from 'react'
import './takt.css'

/**
 * 节拍尺：品牌母题。一排刻度，运行时一个光点按拍子逐格前进（传送带），空闲时静止。
 * 用在顶栏下沿、全局加载与空状态里。
 */
export function TaktRuler({ ticks = 12, running = false, step, className }: { ticks?: number; running?: boolean; step?: number; className?: string }) {
  const style = { '--ticks': ticks, ...(step ? { '--step': `${step}ms` } : null) } as CSSProperties
  return (
    <span className={`takt-ruler${running ? ' running' : ''}${className ? ` ${className}` : ''}`} style={style} aria-hidden>
      {Array.from({ length: ticks }, (_, i) => (
        <span key={i} className={i % 4 === 0 ? 'bar' : undefined} style={{ '--i': i } as CSSProperties} />
      ))}
    </span>
  )
}

/** 全局 / 区块加载：节拍尺快拍 + 一句说明。label 写清在等什么。 */
export function TaktLoader({ label = '正在载入', compact }: { label?: ReactNode; compact?: boolean }) {
  return (
    <div className={`takt-loader${compact ? ' compact' : ''}`} role="status" aria-live="polite">
      <TaktRuler ticks={9} running step={110} />
      <span className="takt-loader-label">{label}</span>
    </div>
  )
}

/** 运行中的节拍指示：顶栏用。count=0 时安静显示"空闲"。 */
export function TaktBeat({ count }: { count: number }) {
  const live = count > 0
  return (
    <span className={`takt-beat${live ? ' live' : ''}`}>
      <span className="takt-beat-dot" aria-hidden />
      {live ? (
        <>
          <span className="num">{count}</span> 个需求在跑
        </>
      ) : (
        '流水线空闲'
      )}
    </span>
  )
}
