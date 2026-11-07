import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { prefersReducedMotion } from '../../lib/motion'

export interface StaggerProps {
  className?: string
  style?: CSSProperties
}

/**
 * 列表首屏逐项入场（体验基线 4）：每项间隔 24ms，最多 10 项，单项 160ms；
 * 首次拿到数据（n > 0）后只播一次，之后的数据更新不再入场（新行用 useFlashRows）。
 *   const st = useStagger(rows.length)
 *   rows.map((r, i) => <tr key={r.id} style={st(i).style} className={`row ${st(i).className ?? ''}`}>…)
 *   或在没有自己 className / style 的元素上直接展开：<li key={r.id} {...st(i)}>
 */
export function useStagger(n: number, opts: { max?: number; step?: number; duration?: number } = {}): (i: number) => StaggerProps {
  const { max = 10, step = 24, duration = 160 } = opts
  const [phase, setPhase] = useState<'wait' | 'play' | 'done'>(n > 0 ? 'play' : 'wait')
  const count = useRef(n)
  useEffect(() => {
    if (phase === 'wait' && n > 0) {
      count.current = n
      setPhase('play')
    }
  }, [n, phase])
  useEffect(() => {
    if (phase !== 'play') return
    const total = prefersReducedMotion() ? duration : Math.min(count.current, max) * step + duration + 40
    const t = setTimeout(() => setPhase('done'), total)
    return () => clearTimeout(t)
  }, [phase, max, step, duration])
  return (i: number) => {
    if (phase !== 'play' || i >= max) return {}
    return { className: 'stagger-item', style: { '--stagger-delay': `${i * step}ms` } as CSSProperties }
  }
}
