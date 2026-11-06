import type { AttentionItem } from '../interfaces.js'
import type { EventPayloads, RunBudget } from '../types.js'
import { budgetUsage, type BudgetUsed } from '../util/budget.js'
import type { HarnessHost } from './harness.js'
import { recordAnswerOnce } from './answers.js'

export class BudgetGuard {
  readonly handled: string[] = []
  private queue = Promise.resolve(false)
  private waiting = false
  constructor(private readonly host: HarnessHost, private readonly persist: () => Promise<void>) {}

  async restore(): Promise<void> {
    const items = (await this.host.deps.stores.attention.list({ requirementId: this.host.state.requirementId }))
      .filter((item) => item.runId === this.host.state.runId && item.kind === 'budget')
    for (const item of items) {
      if (!item.answeredAt || this.handled.includes(item.requestId)) continue
      await recordAnswerOnce(this.host.deps.stores, this.host.state.runId, item)
      if (item.answer === '追加 50% 预算' && item.decision === 'choice') {
        const budget = this.host.state.budget!
        for (const key of Object.keys(budget) as Array<keyof RunBudget>) if (budget[key] !== undefined) budget[key]! *= 1.5
      } else this.host.state.status = 'cancelled'
      this.handled.push(item.requestId)
      await this.host.save()
      await this.persist()
    }
    this.waiting = items.some((item) => !item.answeredAt)
  }

  get paused(): boolean { return this.waiting }
  check(): Promise<boolean> {
    const next = this.queue.then(() => this.inspect())
    this.queue = next.catch(() => false)
    return next
  }

  private async inspect(): Promise<boolean> {
    if (this.waiting || this.host.signal.aborted) return false
    const { state, deps } = this.host
    if (!state.budget) return true
    const events = await deps.stores.events.read(state.runId)
    const used: BudgetUsed = { tokens: 0, minutes: Math.max(0, (Date.parse(this.host.timestamp()) - Date.parse(state.startedAt)) / 60000) }
    for (const event of events) if (event.type === 'harness.usage') {
      const usage = event.data as EventPayloads['harness.usage']
      used.tokens += usage.inputTokens + usage.outputTokens
      if (usage.costUsd !== undefined) used.costUsd = (used.costUsd ?? 0) + usage.costUsd
    }
    const usage = budgetUsage(state.budget, used)
    if (usage.state === 'ok') return true
    const warned = events.some((event) => event.type === 'budget.warning' &&
      JSON.stringify((event.data as EventPayloads['budget.warning']).budget) === JSON.stringify(state.budget))
    const data = { budget: { ...state.budget }, used, ratio: usage.ratio }
    if (!warned) await this.host.emit('budget.warning', data)
    if (usage.state !== 'exhausted') return true
    this.waiting = true
    await this.host.emit('budget.exhausted', data)
    const items = await deps.stores.attention.list({ requirementId: state.requirementId })
    const requestId = `${state.runId}:budget#${items.filter((item) => item.runId === state.runId && item.kind === 'budget').length + 1}`
    const item: Omit<AttentionItem, 'createdAt'> = { requestId, runId: state.runId, requirementId: state.requirementId, nodeId: 'budget',
      kind: 'budget', ask: '运行预算已耗尽，请追加预算或停止运行', form: 'choice', choices: ['追加 50% 预算', '停止运行'] }
    await deps.stores.attention.create(item)
    await this.host.emit('human.requested', { requestId, ask: item.ask, form: item.form, choices: item.choices }, item.nodeId)
    return false
  }
}
