import type { AttentionItem } from '../interfaces.js'
import type { EventPayloads } from '../types.js'
import { budgetUsage, type BudgetUsed } from '../util/budget.js'
import type { HarnessHost } from './harness.js'
import { recordAnswerOnce } from './answers.js'

export class BudgetGuard {
  readonly handled: string[] = []
  private queue = Promise.resolve(false)
  private waiting = false
  private used: BudgetUsed = { tokens: 0, minutes: 0 }
  private readonly warned = new Set<string>()

  async initialize(): Promise<void> {
    for (const event of await this.host.deps.stores.events.read(this.host.state.runId)) {
      if (event.type === 'harness.usage') this.addUsage(event.data as EventPayloads['harness.usage'])
      if (event.type === 'budget.warning') this.warned.add(JSON.stringify((event.data as EventPayloads['budget.warning']).budget))
    }
  }

  addUsage(usage: EventPayloads['harness.usage']): void {
    this.used.tokens += usage.inputTokens + usage.outputTokens
    if (usage.costUsd !== undefined) this.used.costUsd = (this.used.costUsd ?? 0) + usage.costUsd
  }

  private usage(): BudgetUsed {
    return { ...this.used, minutes: Math.max(0, (Date.parse(this.host.timestamp()) - Date.parse(this.host.state.startedAt)) / 60000) }
  }
  constructor(private readonly host: HarnessHost, private readonly persist: () => Promise<void>) {}

  async restore(): Promise<void> {
    const items = (await this.host.deps.stores.attention.list({ requirementId: this.host.state.requirementId }))
      .filter((item) => item.runId === this.host.state.runId && item.kind === 'budget')
    for (const item of items) {
      if (!item.answeredAt || this.handled.includes(item.requestId)) continue
      await recordAnswerOnce(this.host.deps.stores, this.host.state.runId, item)
      if (item.answer === '追加 50% 预算' && item.decision === 'choice') {
        const budget = this.host.state.budget!
        const used = this.usage()
        // 等人和在途节点可能超出旧额度；追加后至少留出旧额度的一半。并发不是消耗额度。
        for (const key of ['tokens', 'costUsd', 'minutes'] as const) if (budget[key] !== undefined) {
          budget[key] = Math.max(budget[key]!, used[key] ?? 0) + budget[key]! * 0.5
        }
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
    const used = this.usage()
    const usage = budgetUsage(state.budget, used)
    if (usage.state === 'ok') return true
    const key = JSON.stringify(state.budget)
    const warned = this.warned.has(key)
    const data = { budget: { ...state.budget }, used, ratio: usage.ratio }
    if (!warned) { this.warned.add(key); await this.host.emit('budget.warning', data) }
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
