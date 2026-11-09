import { spaceLock } from './space-lock.js'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { AutomationRecords, cronMatches, openProject, systemWrite, timeboxMs,
  type AutomationConfig, type AutomationRunRecord, type RunStatus, type ProjectStores } from '@taktflow/core'
import { collectSecrets, createRedactor } from '@taktflow/harness'
import { automationAction, type AutomationActionOptions } from './automation-actions.js'
import { automationProblems } from './automation-config.js'
import { sendToChannel } from './channel-delivery.js'
import { atomicWrite } from './space.js'
import { HttpError } from './http.js'

export interface AutomationRuntimeOptions extends AutomationActionOptions { fetch?: typeof fetch; onError?: (error: unknown) => void; getStores?: () => ProjectStores }
export class AutomationRuntime {
  private active = new Set<string>()
  private pending = new Set<Promise<unknown>>()
  private statuses = new Map<string, RunStatus>()
  private stores?: Promise<ProjectStores>
  private requirements = new Set<string>()
  private overdue = new Set<string>()
  private closed = false
  private timer?: ReturnType<typeof setTimeout>
  private scanner?: ReturnType<typeof setInterval>
  private scanning?: Promise<void>
  private startedAt = Date.now()
  private scheduledMinute?: number
  constructor(readonly projectDir: string, private options: AutomationRuntimeOptions) {}
  private getStores(): Promise<ProjectStores> {
    return this.options.getStores ? Promise.resolve(this.options.getStores()) : this.stores ??= openProject(this.projectDir)
  }
  private report = (error: unknown) => { this.options.onError?.(error) }
  private track<T>(work: Promise<T>): Promise<T> {
    this.pending.add(work); void work.finally(() => this.pending.delete(work)).catch(() => {})
    return work
  }
  async start(): Promise<void> {
    const stores = await this.getStores()
    await new AutomationRecords(stores).recover()
    this.requirements = new Set((await stores.workspaces.listRequirements()).map(r => r.id))
    try { this.overdue = new Set(JSON.parse(await readFile(join(stores.taktDir, 'automations/overdue.json'), 'utf8')) as string[]) }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    for (const run of await stores.runs.list()) this.statuses.set(run.runId, run.status)
    await this.scan()
    this.scanner = setInterval(() => { if (!this.scanning) this.scanning = this.scan().catch(this.report).finally(() => { this.scanning = undefined }) }, 5000)
    this.scanner.unref()
    this.arm()
  }
  private arm() {
    if (this.closed) return
    this.timer = setTimeout(() => {
      // 先排下一分钟，当前动作再慢也不能阻止下一轮记录 skipped。
      this.arm(); void this.track(this.tick()).catch(this.report)
    }, 60_000 - Date.now() % 60_000)
    this.timer.unref()
  }
  async tick(now = new Date()): Promise<void> {
    if (this.closed) return
    const stores = await this.getStores()
    const minute = Math.floor(now.getTime() / 60_000)
    const due = this.scheduledMinute !== minute
    this.scheduledMinute = minute
    for (const automation of stores.config.automations ?? []) {
      if (!due || !automation.enabled || !('schedule' in automation.trigger)) continue
      try { if (cronMatches(automation.trigger.schedule, now)) void this.execute(automation.id, 'schedule').catch(this.report) }
      catch (error) { this.report(error) }
    }
    await this.checkOverdue(stores, now)
  }
  private async checkOverdue(stores: ProjectStores, now: Date) {
    for (const item of await stores.attention.list()) {
      if (item.kind === 'assumption' || item.answeredAt && !item.handedBack || this.overdue.has(item.requestId)) continue
      const box = item.timebox ?? stores.config.human
      const limit = timeboxMs(box?.remindAfter) ?? timeboxMs(box?.handbackAfter)
      if (!limit || now.getTime() - Date.parse(item.createdAt) < limit) continue
      this.overdue.add(item.requestId)
      const file = join(stores.taktDir, 'automations/overdue.json')
      await systemWrite(stores.projectDir, ['.takt/automations/**'], () => atomicWrite(file, JSON.stringify([...this.overdue])))
      await this.dispatch({ type: 'attention.overdue', runId: item.runId, requirementId: item.requirementId, nodeId: item.nodeId })
    }
  }
  async scan(): Promise<void> {
    if (this.closed) return
    const stores = await this.getStores()
    const requirements = await stores.workspaces.listRequirements()
    for (const req of requirements) if (!this.requirements.has(req.id)) {
      this.requirements.add(req.id)
      if (Date.parse(req.createdAt) >= this.startedAt) await this.dispatch({ type: 'requirement.created', requirementId: req.id })
    }
    // 状态轮询避免为历史运行维护文件订阅；新运行在两次轮询之间结束也能被识别。
    for (const run of await stores.runs.list()) {
      if (this.closed) return
      const previous = this.statuses.get(run.runId)
      this.statuses.set(run.runId, run.status)
      if (previous === run.status || previous && ['succeeded', 'failed', 'cancelled'].includes(previous)) continue
      if (run.status !== 'succeeded' && run.status !== 'failed') continue
      if (previous === undefined && Date.parse(run.startedAt) < this.startedAt) continue
      await this.dispatch({ type: run.status === 'succeeded' ? 'run.finished' : 'run.failed', runId: run.runId, requirementId: run.requirementId })
    }
  }
  async dispatch(event: NonNullable<AutomationRunRecord['event']>): Promise<void> {
    if (this.closed) return
    const stores = await this.getStores(), run = event.runId ? await stores.runs.get(event.runId) : undefined
    for (const automation of stores.config.automations ?? []) {
      if (!automation.enabled || !('event' in automation.trigger) || automation.trigger.event !== event.type) continue
      const filter = automation.trigger.filter
      if (filter?.workflowIds && !filter.workflowIds.includes(run?.workflowId ?? '')) continue
      if (filter?.requirementIds && !filter.requirementIds.includes(event.requirementId ?? '')) continue
      if (automation.action.kind === 'start_workflow' && run?.args.__taktAutomation) continue
      void this.execute(automation.id, 'event', event).catch(this.report)
    }
  }
  execute(id: string, trigger: AutomationRunRecord['trigger'], event?: AutomationRunRecord['event'], retryOf?: string): Promise<AutomationRunRecord> {
    if (this.closed) return Promise.reject(new HttpError(409, '空间正在卸载，请稍后重试'))
    const busy = this.active.has(id)
    if (!busy) this.active.add(id)
    return this.track(this.perform(id, trigger, event, retryOf, busy).finally(() => { if (!busy) this.active.delete(id) }))
  }
  private async perform(id: string, trigger: AutomationRunRecord['trigger'], event: AutomationRunRecord['event'], retryOf: string | undefined, busy: boolean): Promise<AutomationRunRecord> {
    const stores = await this.getStores(), automation = stores.config.automations?.find(a => a.id === id)
    if (!automation) throw new HttpError(404, '自动化不存在，请刷新列表')
    const records = new AutomationRecords(stores)
    if (trigger === 'retry') {
      const original = (await records.list(id)).find(r => r.id === retryOf)
      if (!original || original.status !== 'failed') throw new HttpError(409, '只有 failed 记录可以重试，请刷新执行记录')
      event = original.event
    }
    const record: AutomationRunRecord = { id: randomUUID(), automationId: id, at: new Date().toISOString(), trigger, event, retryOf, status: busy ? 'skipped' : 'running', summary: busy ? '上一轮尚未结束，跳过本轮' : '正在执行', deliveries: [] }
    await records.write(record)
    if (busy) return record
    try {
      const problems = await automationProblems(automation, stores)
      if (problems.length) { record.status = 'skipped'; record.summary = problems.join('；'); return record }
      const lastSuccess = (await records.list(id)).find(r => r.status === 'ok')?.at
      const runAction = () => automationAction(stores, automation, record, this.options, lastSuccess)
      // 同一需求的多个自动化不能同时通过“无运行”检查。
      const message = automation.action.kind === 'start_workflow'
        ? await spaceLock(join(stores.taktDir, 'automations/start'), runAction) : await runAction()
      if (!message) return record
      for (const channelId of [...new Set(automation.notify?.channels ?? [])]) {
        const channel = stores.config.channels!.find(c => c.id === channelId)!
        record.deliveries.push(await sendToChannel(channel, message, this.options.fetch))
      }
      record.status = record.deliveries.every(d => d.ok) ? 'ok' : 'failed'
      if (record.status === 'failed') { record.error = '部分渠道发送失败，请检查发送回执后重试'; record.summary = record.error }
    } catch (error) {
      record.status = 'failed'
      record.error = createRedactor(collectSecrets(undefined, stores.config.providers))(error instanceof Error ? error.message : String(error))
      record.summary = `执行失败：${record.error}`
    } finally {
      record.durationMs = Date.now() - Date.parse(record.at)
      await records.write(record)
    }
    return record
  }
  async close(): Promise<void> {
    this.closed = true; clearTimeout(this.timer); clearInterval(this.scanner)
    await this.scanning
    await Promise.allSettled([...this.pending])
  }
}
