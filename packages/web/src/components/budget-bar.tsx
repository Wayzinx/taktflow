import type { CSSProperties } from 'react'
import { Gauge } from 'lucide-react'
import type { BudgetStatus } from '@taktflow/core'
import { fmtCost, fmtTokens } from '../lib/format'
import { Link } from '../lib/router'
import './budget-bar.css'

type Tone = 'running' | 'warning' | 'danger'

const STATE_TEXT: Record<BudgetStatus['state'], string> = {
  ok: '用量正常',
  warning: '接近上限，Lead 已通报',
  exhausted: '已用尽，新节点暂停调度',
}

/** 各项用量 / 预算，只列配置了的那几项。 */
function dims(b: BudgetStatus): Array<{ key: string; label: string; used: string; limit: string; ratio: number }> {
  const out: Array<{ key: string; label: string; used: string; limit: string; ratio: number }> = []
  const { budget, used } = b
  if (budget.tokens) out.push({ key: 'tokens', label: 'Token', used: fmtTokens(used.tokens), limit: fmtTokens(budget.tokens), ratio: used.tokens / budget.tokens })
  if (budget.costUsd) out.push({ key: 'cost', label: '成本', used: fmtCost(used.costUsd ?? 0), limit: fmtCost(budget.costUsd), ratio: (used.costUsd ?? 0) / budget.costUsd })
  if (budget.minutes) out.push({ key: 'minutes', label: '时长', used: `${Math.round(used.minutes)}`, limit: `${budget.minutes} min`, ratio: used.minutes / budget.minutes })
  return out
}

/**
 * 预算条（D 组）：需求页顶部常驻。填充用 `.meter`（scaleX），ratio ≥ 0.8 变 warning 色，≥ 1 变 danger 色。
 * budget 为空表示还没有运行或运行没有预算。
 */
export function BudgetBar({ budget, runId }: { budget?: BudgetStatus; runId?: string }) {
  if (!budget) return null
  const ratio = Math.max(0, budget.ratio)
  const tone: Tone = ratio >= 1 || budget.state === 'exhausted' ? 'danger' : ratio >= 0.8 || budget.state === 'warning' ? 'warning' : 'running'
  const pct = Math.round(ratio * 100)
  const items = dims(budget)
  // 运行没有配预算（真实数据常见：budget 为 {}，ratio 为 0）：不画 0% 的进度条，只报已用量
  if (items.length === 0)
    return (
      <div className="budget-bar is-unset" aria-label="运行预算">
        <span className="budget-label">
          <Gauge aria-hidden />
          预算
        </span>
        <span className="budget-state faint">未设预算</span>
        <span className="budget-dims">
          <span className="budget-dim">
            <span className="faint">已用 Token</span>
            <span className="mono num">{fmtTokens(budget.used.tokens)}</span>
          </span>
          {budget.used.costUsd !== undefined && (
            <span className="budget-dim">
              <span className="faint">成本</span>
              <span className="mono num">{fmtCost(budget.used.costUsd)}</span>
            </span>
          )}
          {budget.budget.concurrency !== undefined && (
            <span className="budget-dim" title="同时运行的节点数上限">
              <span className="faint">并发</span>
              <span className="mono num">≤ {budget.budget.concurrency}</span>
            </span>
          )}
        </span>
        {runId && (
          <Link to={`/run/${runId}`} className="budget-run mono">
            {runId}
          </Link>
        )}
      </div>
    )
  return (
    <div className="budget-bar" data-tone={tone} aria-label="运行预算">
      <span className="budget-label">
        <Gauge aria-hidden />
        预算
      </span>
      <span className="budget-meter-wrap">
        <span className="meter meter-lg" data-tone={tone} role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-label={`预算用量 ${pct}%`} style={{ '--meter': Math.min(1, ratio) } as CSSProperties}>
          <span className="meter-fill" />
        </span>
        {/* 80% 告警线：刻度和节拍尺的长刻度一个样子 */}
        <span className="budget-tick" aria-hidden />
      </span>
      <span className="budget-pct mono num">{pct}%</span>
      <span className="budget-state">{STATE_TEXT[budget.state]}</span>
      <span className="budget-dims">
        {items.map((d) => (
          <span key={d.key} className={`budget-dim${d.ratio >= 0.8 ? ' hot' : ''}`} title={`${d.label} ${Math.round(d.ratio * 100)}%`}>
            <span className="faint">{d.label}</span>
            <span className="mono num">
              {d.used}
              <span className="faint"> / {d.limit}</span>
            </span>
          </span>
        ))}
        {budget.budget.concurrency !== undefined && (
          <span className="budget-dim" title="同时运行的节点数上限">
            <span className="faint">并发</span>
            <span className="mono num">≤ {budget.budget.concurrency}</span>
          </span>
        )}
      </span>
      {runId && (
        <Link to={`/run/${runId}`} className="budget-run mono">
          {runId}
        </Link>
      )}
    </div>
  )
}
