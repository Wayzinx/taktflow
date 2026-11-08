import type { CSSProperties } from 'react'
import type { RunSpark } from '@taktflow/core'
import { fmtRelative, fmtTokens } from '../../lib/format'
import { RUN_STATUS } from '../../lib/status'

/**
 * 迷你折线（docs/design/25 §3）：读数格里的 14 天趋势。少于 2 个点不画；全为 0 画一条贴底的平线。
 * 首次出现描线 400ms（pathLength 归一），数据更新直接换形不重播。
 */
export function Sparkline({ values, label, width = 64, height = 22, className }: { values: number[]; label: string; width?: number; height?: number; className?: string }) {
  if (values.length < 2) return null
  const max = Math.max(...values)
  const pad = 2
  const x = (i: number) => pad + (i / (values.length - 1)) * (width - pad * 2)
  const y = (v: number) => height - pad - (max ? (v / max) * (height - pad * 2) : 0)
  const pts = values.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`)
  const line = `M${pts.join('L')}`
  const area = `${line}L${x(values.length - 1).toFixed(1)},${height}L${x(0).toFixed(1)},${height}Z`
  const last = values[values.length - 1]!
  return (
    <svg className={`spark${className ? ` ${className}` : ''}`} width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={label}>
      <title>{label}</title>
      <path className="spark-area" d={area} />
      <path className="spark-line" d={line} pathLength={1} />
      <circle className="spark-dot" cx={x(values.length - 1)} cy={y(last)} r={2.2} />
    </svg>
  )
}

const RUN_TONE: Partial<Record<RunSpark['status'], string>> = {
  failed: 'var(--st-failed)',
  running: 'var(--accent)',
  waiting_human: 'var(--st-waiting)',
  cancelled: 'var(--border-strong)',
}

/**
 * 最近几次运行的迷你柱：高 = Token、色 = 结果（失败红、等人琥珀、运行中节拍橙、成功中性灰）；
 * Lead 派发的任务运行画得更淡。每根柱子悬停写明是哪次运行。
 */
export function RunBars({ runs, height = 16, className }: { runs: RunSpark[]; height?: number; className?: string }) {
  if (!runs.length) return null
  const max = Math.max(1, ...runs.map((r) => r.tokens))
  const w = 3
  const gap = 2
  const width = runs.length * (w + gap) - gap
  return (
    <svg className={`run-bars${className ? ` ${className}` : ''}`} width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`最近 ${runs.length} 次运行`}>
      {runs.map((r, i) => {
        const h = Math.max(3, Math.round((r.tokens / max) * height))
        return (
          <rect
            key={r.runId}
            x={i * (w + gap)}
            y={height - h}
            width={w}
            height={h}
            rx={1}
            className="run-bar"
            data-live={r.status === 'running' || undefined}
            data-task={r.kind === 'task' || undefined}
            style={{ fill: RUN_TONE[r.status] ?? 'var(--c-7)', '--i': i } as CSSProperties}
          >
            <title>{`${r.runId} · ${RUN_STATUS[r.status].label} · ${r.tokens ? fmtTokens(r.tokens) : '无用量'} · ${fmtRelative(r.startedAt)}${r.kind === 'task' ? ' · 任务' : ''}`}</title>
          </rect>
        )
      })}
    </svg>
  )
}
