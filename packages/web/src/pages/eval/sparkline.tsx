import type { NodeScorecard } from '@taktflow/core'
import { pct, shortHash } from './labels'

/**
 * 配方趋势小图：每个点是一个配方的一次通过率（按首次出现时间）。
 * 退化时最后一段用失败色并加空心圈；只有一个配方时画一个点。静态 SVG，不加动画。
 */
export function Sparkline({ trend, regressed, width = 76, height = 22 }: { trend?: NodeScorecard['trend']; regressed?: boolean; width?: number; height?: number }) {
  const pts = (trend ?? []).filter((t) => t.firstPassRate !== undefined)
  if (pts.length === 0) return <span className="faint">—</span>
  const pad = 3
  const x = (i: number) => (pts.length === 1 ? width / 2 : pad + (i * (width - pad * 2)) / (pts.length - 1))
  const y = (v: number) => pad + (1 - v) * (height - pad * 2)
  const coords = pts.map((p, i) => [x(i), y(p.firstPassRate!)] as const)
  const title = pts.map((p) => `${shortHash(p.recipeKey, 6)} · ${pct(p.firstPassRate)} · ${p.executions} 次`).join('\n')
  const head = coords.slice(0, regressed ? -1 : undefined)
  const last = coords.at(-1)!
  const prev = coords.at(-2)
  return (
    <svg className={`spark${regressed ? ' spark-bad' : ''}`} width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`配方趋势：${title.replace(/\n/g, '；')}`}>
      <title>{title}</title>
      <line x1={pad} x2={width - pad} y1={y(0.8)} y2={y(0.8)} className="spark-ref" />
      {head.length > 1 && <polyline points={head.map((c) => c.join(',')).join(' ')} className="spark-line" />}
      {regressed && prev && <line x1={prev[0]} y1={prev[1]} x2={last[0]} y2={last[1]} className="spark-drop" />}
      {coords.map(([cx, cy], i) => (
        <circle key={i} cx={cx} cy={cy} r={i === coords.length - 1 ? 2.6 : 1.8} className={i === coords.length - 1 ? (regressed ? 'spark-dot-bad' : 'spark-dot-last') : 'spark-dot'} />
      ))}
    </svg>
  )
}
