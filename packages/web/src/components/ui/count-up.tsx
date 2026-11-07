import { useEffect, useRef, useState } from 'react'
import { prefersReducedMotion } from '../../lib/motion'

/**
 * 数字过渡（体验基线 5）：从旧值过渡到新值，400ms，--ease-out-soft 近似曲线，等宽数字。
 * 首屏从 0 起跳只用于总览统计（from0）；其余场景首次渲染直接显示终值，之后变化才过渡。
 *   <CountUp value={totals.active} from0 />
 *   <CountUp value={0.873} format={(v) => `${(v * 100).toFixed(1)}%`} />
 */
export function CountUp({ value, format, duration = 400, from0, className }: { value: number; format?: (v: number) => string; duration?: number; from0?: boolean; className?: string }) {
  // 默认格式按终值决定精度：整数终值的中间帧也取整，不会闪出 0.92 这样的小数
  const fmt = format ?? (Number.isInteger(value) ? formatInt : defaultFormat)
  const [shown, setShown] = useState(from0 && !prefersReducedMotion() ? 0 : value)
  const from = useRef(shown)
  const raf = useRef(0)
  useEffect(() => {
    if (!Number.isFinite(value)) return setShown(value)
    if (prefersReducedMotion() || from.current === value) {
      from.current = value
      return setShown(value)
    }
    const start = performance.now()
    const a = from.current
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / duration)
      const v = a + (value - a) * ease(t)
      from.current = v
      setShown(v)
      if (t < 1) raf.current = requestAnimationFrame(tick)
      else from.current = value
    }
    raf.current = requestAnimationFrame(tick)
    // 兜底：后台标签页 / 无头截图里 rAF 可能不跑，到时间直接落到终值，不会停在中间数
    const done = window.setTimeout(() => {
      cancelAnimationFrame(raf.current)
      from.current = value
      setShown(value)
    }, duration + 80)
    return () => {
      cancelAnimationFrame(raf.current)
      window.clearTimeout(done)
    }
  }, [value, duration])
  return (
    <span className={`num count-up${className ? ` ${className}` : ''}`} aria-label={fmt(value)}>
      <span aria-hidden>{fmt(shown)}</span>
    </span>
  )
}

/** cubic-bezier(.2,.8,.2,1) 的近似：快出稳停。 */
function ease(t: number): number {
  return 1 - Math.pow(1 - t, 3.2)
}

function formatInt(v: number): string {
  return Math.round(v).toLocaleString('zh-CN')
}

function defaultFormat(v: number): string {
  return v.toLocaleString('zh-CN', { maximumFractionDigits: 2 })
}
