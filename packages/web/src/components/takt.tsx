import type { CSSProperties, ReactNode } from 'react'
import { GLOSSARY } from '../lib/glossary'
import { Link } from '../lib/router'
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

/**
 * 顶栏节拍指示：当前空间有几个需求的节点正在跑（点开去看）；没有时安静显示。
 * 和服务断开时变灰、写明"连接已断开"（不能还说"空闲"），点一下立刻重试。
 */
export function TaktBeat({ count, to = '/requirements', offline, onRetry }: { count: number; to?: string; offline?: boolean; onRetry?: () => void }) {
  if (offline)
    return (
      <button type="button" className="takt-beat offline" onClick={onRetry} title="连不上 takt serve：页面上的数据可能已经过期。恢复后会自动刷新，点这里立即重试">
        <span className="takt-beat-dot" aria-hidden />
        连接已断开
      </button>
    )
  const live = count > 0
  const hint = live ? `当前空间有 ${count} 个需求的节点正在运行，点开查看` : `当前空间没有节点在运行。“进行中”是${GLOSSARY.进行中.hint}`
  return (
    <Link to={to} className={`takt-beat${live ? ' live' : ''}`} title={hint} aria-label={live ? `${count} 个需求在跑，查看` : '没有需求在跑，查看需求列表'}>
      <span className="takt-beat-dot" aria-hidden />
      {live ? (
        <>
          <span className="num">{count}</span> 个需求在跑
        </>
      ) : (
        '没有需求在跑'
      )}
    </Link>
  )
}
