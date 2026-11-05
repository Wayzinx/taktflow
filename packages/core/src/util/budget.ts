import type { RunBudget } from '../types.js'

export interface BudgetUsed { tokens: number; costUsd?: number; minutes: number }

/** 告警线：用量达到预算的 80% 发 budget.warning。 */
export const BUDGET_WARNING_RATIO = 0.8

/** 各项用量 / 预算取最大值；引擎调度与读模型共用同一口径。没有任何预算项时 ratio 为 0。 */
export function budgetUsage(budget: RunBudget | undefined, used: BudgetUsed): { ratio: number; state: 'ok' | 'warning' | 'exhausted' } {
  const ratios = [
    budget?.tokens ? used.tokens / budget.tokens : 0,
    budget?.costUsd && used.costUsd !== undefined ? used.costUsd / budget.costUsd : 0,
    budget?.minutes ? used.minutes / budget.minutes : 0,
  ]
  const ratio = Math.max(...ratios)
  return { ratio, state: ratio >= 1 ? 'exhausted' : ratio >= BUDGET_WARNING_RATIO ? 'warning' : 'ok' }
}

/** 配置 < workflow 默认 < 启动参数，逐项覆盖。 */
export function mergeBudget(...layers: Array<RunBudget | undefined>): RunBudget | undefined {
  const merged = Object.assign({}, ...layers.filter(Boolean)) as RunBudget
  return Object.keys(merged).length ? merged : undefined
}
