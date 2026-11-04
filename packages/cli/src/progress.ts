import type { EventEnvelope, EventType, RunState } from '@taktflow/core'
import { formatDuration, type Printer } from './output.js'
import { stageIndex, stageOf } from './project.js'
import type { WorkflowDefinition } from '@taktflow/core'

const oneLine = (text: string): string => text.replace(/[\r\n]+\s*/g, ' ').trim()

/** 运行中打印一行一条进度；耗时按事件 ts 计算（批量补读时不能用 Date.now）。 */
export class ProgressFeed {
  private readonly stages: Map<string, string>
  private readonly startedAt = new Map<string, number>()
  private readonly iterations = new Map<string, number>()
  private maxSeq = 0

  constructor(private readonly printer: Printer, workflow: WorkflowDefinition) {
    this.stages = stageIndex(workflow)
  }

  get lastSeq(): number {
    return this.maxSeq
  }

  /** 返回是否打印了内容；事件按 seq 去重。 */
  consume(event: EventEnvelope, live: boolean): boolean {
    if (event.seq <= this.maxSeq) return false
    this.maxSeq = event.seq
    if (!live) return false
    this.print(event)
    return true
  }

  private print(event: EventEnvelope): void {
    const colors = this.printer.colors
    const stage = event.nodeId === undefined ? undefined : stageOf(this.stages, event.nodeId)
    const prefix = [stage === undefined ? undefined : colors.dim(`[${stage}]`), event.nodeId === undefined ? undefined : colors.cyan(event.nodeId)]
      .filter((part): part is string => part !== undefined).join(' ')
    const label = prefix === '' ? colors.dim('run') : prefix
    const write = (line: string) => this.printer.warn(oneLine(line))
    const data = event.data as Record<string, unknown>
    switch (event.type as EventType) {
      case 'node.started': {
        this.startedAt.set(event.nodeId ?? '', Date.parse(event.ts))
        const iteration = data.iteration as number | undefined
        if (iteration !== undefined && iteration > 0) this.iterations.set(event.nodeId ?? '', iteration)
        const known = this.iterations.get(event.nodeId ?? '')
        const round = known !== undefined && known > 0 ? colors.dim(` 第 ${known} 轮`) : ''
        if (event.nodeId !== undefined) write(`${label} ▶ 开始${round}`)
        break
      }
      case 'node.finished': {
        const id = event.nodeId ?? ''
        const elapsed = formatDuration(Date.parse(event.ts) - (this.startedAt.get(id) ?? Date.parse(event.ts)))
        this.startedAt.delete(id)
        if (event.nodeId !== undefined) write(`${label} ${colors.green(`✔ ${String(data.status ?? 'succeeded')}`)} ${colors.dim(elapsed)}`)
        break
      }
      case 'node.failed': {
        const id = event.nodeId ?? ''
        const elapsed = formatDuration(Date.parse(event.ts) - (this.startedAt.get(id) ?? Date.parse(event.ts)))
        this.startedAt.delete(id)
        if (event.nodeId !== undefined) write(`${label} ${colors.red('✘ 失败')} ${colors.dim(elapsed)} ${colors.dim(oneLine(String(data.error ?? '')))}`)
        break
      }
      case 'node.stale':
        if (event.nodeId !== undefined) write(`${label} ${colors.yellow('! 结果过期')}`)
        break
      case 'gate.result': {
        const checks = Array.isArray(data.checks) ? data.checks as Array<{ id: string; pass: boolean }> : []
        const failed = checks.filter((check) => !check.pass).map((check) => check.id)
        const text = data.pass === true ? colors.green('通过') : colors.red(`未通过（${failed.join(', ')}）`)
        if (event.nodeId !== undefined) write(`${label} ⛩ 门禁 ${text}`)
        break
      }
      case 'judge.verdict': {
        const verdicts = Array.isArray(data.verdicts) ? data.verdicts as Array<{ subject: string; category: string }> : []
        if (event.nodeId !== undefined) write(`${label} ⚖ 判决 ${verdicts.map((verdict) => `${verdict.subject}:${verdict.category}`).join(' ') || '无失败'}`)
        break
      }
      case 'guard.violation':
        if (event.nodeId !== undefined) write(`${label} ${colors.red('⚠ 守卫违规')} ${String(data.rule ?? '')} ${(data.paths as string[] | undefined)?.join(', ') ?? ''}`)
        break
      case 'artifact.written': {
        const ref = data.ref as { path?: string; version?: number } | undefined
        if (event.nodeId !== undefined && ref?.path !== undefined) write(`${label} ${colors.dim(`📄 ${ref.path} v${ref.version ?? '?'}`)}`)
        break
      }
      case 'human.requested':
        write(`${label} ${colors.yellow('⏸ 待人处理')} ${String(data.requestId ?? '')} ${oneLine(String(data.ask ?? ''))}`)
        break
      case 'knowledge.query':
        if (event.nodeId !== undefined) write(`${label} ${colors.dim(`🔎 知识检索 ${(data.hits as number | undefined) ?? 0} 条`)}`)
        break
      case 'run.finished': {
        const status = String(data.status ?? '')
        const line = status === 'succeeded' ? colors.green('运行成功')
          : status === 'waiting_human' ? colors.yellow('等待人工处理')
            : colors.red(`运行${status}`)
        write(`${colors.bold('run')} ${line}`)
        break
      }
      default:
        break
    }
    // node.ready / harness.* / context.* 等高频事件不打印，避免刷屏。
  }
}

export function pendingFor<T extends { runId: string; answeredAt?: string }>(items: T[], runId: string): T[] {
  return items.filter((item) => item.runId === runId && item.answeredAt === undefined)
}

export function printRunSummary(printer: Printer, state: RunState, pending: Array<{ requestId: string; ask: string }>): void {
  const colors = printer.colors
  const nodes = Object.values(state.nodes)
  const done = nodes.filter((node) => node.status === 'succeeded' || node.status === 'skipped').length
  const status = state.status === 'succeeded' ? colors.green(state.status)
    : state.status === 'waiting_human' ? colors.yellow(state.status)
      : colors.red(state.status)
  printer.text('')
  printer.text(`${colors.bold('运行')} ${colors.cyan(state.runId)}  ${status}  ${done}/${nodes.length} 节点`)
  if (pending.length > 0) {
    printer.text(colors.yellow('待办：'))
    for (const item of pending) printer.text(`  ${colors.cyan(item.requestId)} ${oneLine(item.ask)}`)
    printer.text(colors.dim(`回答：takt answer ${pending[0]!.requestId} --approve`))
  }
  const failed = nodes.filter((node) => node.status === 'failed' || node.status === 'blocked')
  if (failed.length > 0) {
    printer.text(colors.red('未完成节点：'))
    for (const node of failed) printer.text(`  ${node.id}  ${oneLine(node.error ?? node.status)}`)
  }
}
