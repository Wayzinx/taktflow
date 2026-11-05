import { createProjectLead, leadEvents } from '../lead.js'
import { isAbsolute, resolve } from 'node:path'
import type { Engine, EventStore, ProjectStores, RunState } from '@taktflow/core'
import { createPrinter, type Printer } from '../output.js'
import type { ParsedCli } from '../args.js'
import { parseRunArgs, UsageError } from '../args.js'
import { createRunEngine, loadRuntime, resolveWorkflow, withMock, type ProjectContext } from '../project.js'
import { ProgressFeed, pendingFor, printRunSummary } from '../progress.js'
import { serializeRun } from '../resume-lock.js'
import { handleInterrupts, withCliLease } from '../lease.js'
import { readRunOptions, saveRunOptions, type RunCliOptions } from '../run-options.js'

export interface RunOptions {
  writeLease?: import('../lease.js').WriteLeaseHook
  project?: string
  harness?: string
  mock?: string
  autoApprove: boolean
  json: boolean
}

/** 跟踪正在执行的引擎：信号或租约续约失败时取消运行，并等引擎收敛后才释放租约。 */
export class ActiveRun {
  private engine: Engine | undefined
  private runId: string | undefined
  private requested = false
  private cancelling: Promise<void> | undefined

  get cancelled(): boolean {
    return this.requested
  }

  async settle(engine: Engine, runId: string): Promise<void> {
    this.engine = engine
    this.runId = runId
    // 取消请求可能早于 run.started；拿到 runId 后补一次。
    if (this.requested) await this.cancel()
  }

  cancel(): Promise<void> {
    this.requested = true
    if (this.engine === undefined || this.runId === undefined) return Promise.resolve()
    // 并发信号只触发一次 engine.cancel，后续调用复用同一个进行中的 Promise。
    this.cancelling ??= this.engine.cancel(this.runId)
    return this.cancelling
  }

  async drain(): Promise<void> {
    if (this.cancelling !== undefined) await this.cancelling
  }
}

const messageOf = (error: unknown): string => error instanceof Error ? error.message : String(error)

/**
 * 执行引擎任务：无论成功还是抛错，都先等取消写入收敛；两个异常同时出现时保留业务错误上下文。
 */
export async function runWithDrain<T>(task: () => Promise<T>, drain: () => Promise<void>): Promise<T> {
  let value: T | undefined
  let failure: unknown
  let failed = false
  try {
    value = await task()
  } catch (error) {
    failure = error
    failed = true
  }
  try {
    await drain()
  } catch (drainError) {
    if (failed) throw new Error(`${messageOf(failure)}；等待取消失败：${messageOf(drainError)}`, { cause: failure })
    throw drainError
  }
  if (failed) throw failure
  return value as T
}

/**
 * 包装 events.append 喂进度，runs.create 落盘 CLI 运行选项（agent 执行前就可用）。
 * run.started 在 requirement 锁释放后发出，在这里等待取消不会与 updateRequirement 死锁。
 */
export function instrument(
  stores: ProjectStores,
  feed: ProgressFeed,
  cliOptions: RunCliOptions,
  onStarted?: (runId: string) => void | Promise<void>,
): ProjectStores {
  const events: EventStore = {
    append: async (runId, event) => {
      const envelope = await stores.events.append(runId, event)
      feed.consume(envelope, true)
      if (event.type === 'run.started') await onStarted?.(runId)
      return envelope
    },
    read: (runId, opts) => stores.events.read(runId, opts),
    subscribe: (runId, onEvent) => stores.events.subscribe(runId, onEvent),
    verify: (runId) => stores.events.verify(runId),
  }
  const runs = Object.create(stores.runs) as ProjectStores['runs']
  runs.create = async (state, workflow) => {
    await stores.runs.create(state, workflow)
    await saveRunOptions(stores.taktDir, state.runId, cliOptions)
  }
  for (const key of ['get', 'getWorkflow', 'save', 'list', 'saveContext', 'saveCompaction', 'getContext'] as const) {
    ;(runs as unknown as Record<string, unknown>)[key] = (stores.runs[key] as (...a: unknown[]) => unknown).bind(stores.runs)
  }
  return { ...stores, events, runs }
}

export async function runWorkflow(cli: ParsedCli): Promise<number> {
  const options = cli.options
  const workflowId = cli.positionals[0]!
  if (options.req === undefined) throw new UsageError('run 需要 --req <REQ>')
  const args = parseRunArgs(options.arg)
  const context = await loadRuntime(options.project, options.mock === undefined ? {} : { mock: options.mock })
  const workflow = await resolveWorkflow(context, workflowId)
  const direct = /[\\/]/.test(workflowId) || workflowId.endsWith('.ts')
  const cliOptions: RunCliOptions = {
    // 和 resolveWorkflow 同一基准：项目根目录，不是 CLI 调用方 cwd。
    ...(direct ? { workflowPath: isAbsolute(workflowId) ? workflowId : resolve(context.stores.projectDir, workflowId) } : {}),
    ...(options.harness === undefined ? {} : { harness: options.harness }),
    ...(options.mock === undefined ? {} : { mock: resolve(options.mock) }),
  }
  const printer = createPrinter(options.json)
  const feed = new ProgressFeed(printer, workflow)
  const requirementId = options.req
  const active = new ActiveRun()
  const interrupts = handleInterrupts(() => active.cancel())
  try {
    const state = await withCliLease(context.stores.taktDir, async () => {
      const monitored = leadEvents(context, await createProjectLead(context))
      let engine: Engine | undefined
      const created = createRunEngine({
        ...monitored,
        stores: instrument(monitored.stores, feed, cliOptions, async (id) => {
          if (engine !== undefined) await active.settle(engine, id)
        }),
      }, {
        harness: options.harness,
        autoApprove: options.autoApprove,
      })
      engine = created
      // 引擎抛错时取消写入也可能还在进行；必须在租约释放前等信号处理和取消都收敛。
      return runWithDrain(
        () => created.start({ workflow, requirementId, args }),
        async () => {
          await interrupts.drain()
          await active.drain()
        },
      )
    }, {
      takeover: options.takeover,
      onRenewError: async () => {
        await active.cancel()
        await active.drain()
      },
    })
    return interrupts.interrupted ? 130 : await finishOutput(context, printer, state)
  } finally {
    interrupts.dispose()
  }
}

export async function resumeWorkflow(cli: ParsedCli): Promise<number> {
  const runId = cli.positionals[0]!
  const context = await loadRuntime(cli.options.project)
  const printer = createPrinter(cli.options.json)
  const active = new ActiveRun()
  // 监听覆盖 acquire → task → release 整个生命周期；resumeRun 内不再重复安装。
  const interrupts = handleInterrupts(() => active.cancel())
  try {
    const state = await withCliLease(context.stores.taktDir, async () => {
      return runWithDrain(
        () => resumeRun(context, runId, cli.options, printer, active),
        async () => {
          await interrupts.drain()
          await active.drain()
        },
      )
    }, {
      takeover: cli.options.takeover,
      onRenewError: async () => {
        await active.cancel()
        await active.drain()
      },
    })
    return interrupts.interrupted ? 130 : await finishOutput(context, printer, state)
  } finally {
    interrupts.dispose()
  }
}

/** 调用方已持有空间租约并安装了唯一的信号监听；answer 复用这里，避免租约嵌套。 */
export async function resumeRun(
  context: ProjectContext,
  runId: string,
  options: RunOptions,
  printer: Printer,
  active = new ActiveRun(),
): Promise<RunState> {
  const current = await context.stores.runs.get(runId)
  if (current?.workflowId.startsWith('task:')) {
    const runtime = await withMock(context, options.mock)
    const lead = await createProjectLead(runtime, options.writeLease)
    await active.settle(createRunEngine(runtime, {}), runId)
    return serializeRun(runId, () => lead.resumeTask(runId))
  }
  return serializeRun(runId, () => resumeOnce(context, runId, options, printer, (engine) => active.settle(engine, runId)))
}

export async function resumeOnce(context: ProjectContext, runId: string, options: RunOptions, printer: Printer, onEngine?: (engine: Engine) => void | Promise<void>): Promise<RunState> {
  const current = await context.stores.runs.get(runId)
  if (!current) throw new Error(`运行不存在：${runId}`)
  const saved = await readRunOptions(context.stores.taktDir, runId)
  const workflow = await resolveWorkflow(context, saved.workflowPath ?? current.workflowId)
  if (workflow.id !== current.workflowId || workflow.version !== current.workflowVersion) {
    throw new Error(`恢复的 workflow 与运行不匹配：运行是 ${current.workflowId}@${current.workflowVersion}，当前是 ${workflow.id}@${workflow.version}`)
  }
  const mockFile = options.mock === undefined ? saved.mock : resolve(options.mock)
  const runtime = mockFile === undefined ? context : await withMock(context, mockFile)
  const harness = options.harness ?? saved.harness
  // 继承记录的选项；显式参数覆盖后写回，后续恢复仍然一致。
  const merged: RunCliOptions = {
    ...saved,
    ...(harness === undefined ? {} : { harness }),
    ...(mockFile === undefined ? {} : { mock: mockFile }),
  }
  await saveRunOptions(context.stores.taktDir, runId, merged)
  const feed = new ProgressFeed(printer, workflow)
  const monitored = leadEvents(runtime, await createProjectLead(runtime, options.writeLease))
  const engine = createRunEngine({ ...monitored, stores: instrument(monitored.stores, feed, merged) }, {
    harness,
    autoApprove: options.autoApprove,
  })
  await onEngine?.(engine)
  return engine.resume(runId, workflow)
}

/** 打印状态摘要 / 待办；--json 时输出单个 RunState。failed/cancelled 用非零退出码。 */
export async function finishOutput(context: ProjectContext, printer: Printer, state: RunState): Promise<number> {
  const pending = pendingFor(await context.stores.attention.list({ pending: true }), state.runId)
  if (printer.json) printer.data({ ...state, attention: pending })
  else printRunSummary(printer, state, pending)
  return state.status === 'failed' || state.status === 'cancelled' ? 1 : 0
}
