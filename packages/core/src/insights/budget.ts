import type { BudgetStatus } from '../api.js'
import type { EventEnvelope, EventPayloads, RunState } from '../types.js'
import { budgetUsage } from '../util/budget.js'

export function budgetStatus(run: RunState, events: EventEnvelope[]): BudgetStatus {
  const used: BudgetStatus['used'] = { tokens: 0, minutes: Math.max(0, ((run.endedAt ? Date.parse(run.endedAt) : Date.now()) - Date.parse(run.startedAt)) / 60_000) }
  for (const event of events) {
    if (event.runId !== run.runId || event.type !== 'harness.usage') continue
    const usage = event.data as EventPayloads['harness.usage']
    used.tokens += usage.inputTokens + usage.outputTokens
    if (usage.costUsd !== undefined) used.costUsd = (used.costUsd ?? 0) + usage.costUsd
  }
  return { budget: run.budget ?? {}, used, ...budgetUsage(run.budget, used) }
}
