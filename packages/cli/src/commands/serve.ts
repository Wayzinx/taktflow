import { createWriteLeaseHook, type WriteLeaseHook } from '../lease.js'
import { access } from 'node:fs/promises'
import { discoverSpaces, createServer, type LeadMention, type ServerOptions } from '@taktflow/server'
import type { AttentionItem, ProjectStores } from '@taktflow/core'
import { createPrinter } from '../output.js'
import { loadRuntime, webDir, type ProjectContext } from '../project.js'
import { serializeRun } from '../resume-lock.js'
import { ActiveRun, resumeOnce, runWithDrain } from './run.js'
import { createRuntimeCatalog } from '../catalog.js'
import { createProjectLead, watchLeadEvents } from '../lead.js'
import { validateRuntime } from '../runtime-validation.js'

export interface ServeOptions {
  project?: string
  spaces?: string
  onLeadMention?: LeadMention
  onSpaceLeadMention?: ServerOptions['onSpaceLeadMention']
  port?: number
  host?: string
  json: boolean
}

const messageOf = (error: unknown): string => error instanceof Error ? error.message : String(error)

async function settleAll(tasks: readonly Promise<unknown>[]): Promise<void> {
  const results = await Promise.allSettled(tasks)
  const failures = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected')
  if (failures.length > 0) throw new Error(failures.map((result) => messageOf(result.reason)).join('；'))
}

/** serve 进程内正在恢复的运行；续约失败或退出时全部取消，等收敛后才释放租约。 */
export class ActiveRuns {
  private readonly runs = new Set<ActiveRun>()
  private stopping = false

  get stopped(): boolean {
    return this.stopping
  }

  start(): ActiveRun {
    const active = new ActiveRun()
    this.runs.add(active)
    // shutdown 已开始：在绑定 engine 前就标记取消，settle 时立即 cancel，不启动新业务。
    if (this.stopping) void active.cancel()
    return active
  }

  finish(active: ActiveRun): void {
    this.runs.delete(active)
  }

  /** shutdown：阻止后续 start 执行业务，并取消当前在途运行。 */
  async stop(): Promise<void> {
    this.stopping = true
    await this.cancelAll()
  }

  /** 全部尝试取消；任何一个取消失败都要抛出来，不能吞掉。 */
  cancelAll(): Promise<void> {
    return settleAll([...this.runs].map((active) => active.cancel()))
  }

  drainAll(): Promise<void> {
    return settleAll([...this.runs].map((active) => active.drain()))
  }
}

/**
 * serve 写生命周期：shutdown 后拒绝新写，并等待已登记的完整写（acquire → fn → release）落定。
 * 这里只包一层 Promise，不改变 withLease 的续约/释放关系。
 */
export class ServeWrites {
  private stopping = false
  private readonly active = new Set<Promise<unknown>>()

  constructor(private readonly hook: WriteLeaseHook) {}

  async run<T>(stores: ProjectStores, fn: () => Promise<T>): Promise<T> {
    this.assertOpen()
    const promise = this.hook(stores, async () => {
      // acquire 期间可能开始 shutdown；拿到租约后再检查，随后由 withLease 释放。
      this.assertOpen()
      return fn()
    })
    this.active.add(promise)
    // 观察 finally 以便清理；原 Promise 的拒绝仍由调用方处理。
    void promise.finally(() => { this.active.delete(promise) }).catch(() => {})
    return promise
  }

  async stop(): Promise<void> {
    this.stopping = true
    // allSettled：单个请求失败不能让 shutdown 提前完成；请求自身的错误由 HTTP 层处理。
    await Promise.allSettled([...this.active])
  }

  private assertOpen(): void {
    if (this.stopping) throw new Error('服务正在关闭，拒绝新的写操作')
  }
}

/** 只依赖 on/off，测试可注入假信号源。 */
export interface SignalTarget {
  on(signal: 'SIGINT' | 'SIGTERM', listener: () => void): unknown
  off(signal: 'SIGINT' | 'SIGTERM', listener: () => void): unknown
}

export interface ShutdownWatch {
  /** 收到第一个信号后 resolve。 */
  readonly signalled: Promise<void>
  /** 幂等：多次信号只触发一次清理，返回同一个 Promise。 */
  stop(): Promise<void>
  /** 服务关闭后卸载监听。 */
  dispose(): void
}

/**
 * 安装退出信号。清理期间监听器保持安装，第二个信号只会命中幂等的 stop，
 * 不会绕过清理；清理错误由调用方 await stop() 上报。
 */
export function watchShutdown(stopWork: () => Promise<void>, target: SignalTarget = process): ShutdownWatch {
  let shutdown: Promise<void> | undefined
  const stop = (): Promise<void> => {
    shutdown ??= stopWork()
    return shutdown
  }
  let resolveSignal!: () => void
  const signalled = new Promise<void>((resolve) => { resolveSignal = resolve })
  const handler = (): void => {
    void stop().catch(() => {})
    resolveSignal()
  }
  target.on('SIGINT', handler)
  target.on('SIGTERM', handler)
  return {
    signalled,
    stop,
    dispose() {
      target.off('SIGINT', handler)
      target.off('SIGTERM', handler)
    },
  }
}

async function webDirectory(): Promise<string | undefined> {
  try {
    await access(webDir)
    return webDir
  } catch {
    return undefined
  }
}

export async function runServe(options: ServeOptions): Promise<void> {
  if (options.project && options.spaces) throw new Error('--project 与 --spaces 不能同时指定')
  const contexts = options.spaces
    ? await Promise.all((await discoverSpaces(options.spaces)).map((stores) => loadRuntime(stores.projectDir)))
    : [await loadRuntime(options.project)]
  for (const context of contexts) validateRuntime(context)
  const activeRuns = new ActiveRuns()
  const leads = new Map<string, Awaited<ReturnType<typeof createProjectLead>>>()
  const writes = new ServeWrites(createWriteLeaseHook({
    onRenewError: async () => { await settleAll([activeRuns.cancelAll(), ...[...leads.values()].map((lead) => lead.cancelAll())]) },
  }))
  const withWriteLease: WriteLeaseHook = (stores, fn) => writes.run(stores, fn)
  const loadedLeads = new Map(await Promise.all(contexts.map(async (context) => [context.stores.projectDir, await createProjectLead(context, withWriteLease)] as const)))
  for (const [dir, lead] of loadedLeads) leads.set(dir, lead)
  const stops = await Promise.all(contexts.map((context) => watchLeadEvents(context, leads.get(context.stores.projectDir)!)))
  const context = contexts[0]!
  const printer = createPrinter(options.json)
  const dir = await webDirectory()
  if (dir === undefined) {
    printer.warn(`Web 控制台未构建（${webDir} 不存在），先运行 npm run build -w @taktflow/web；API 仍可用。`)
  }
  const serverOptions: ServerOptions = {
    withWriteLease,
    onLeadMention: options.onLeadMention,
    onSpaceLeadMention: options.onSpaceLeadMention ?? (options.onLeadMention
      ? (_, id, message) => options.onLeadMention!(id, message)
      : async (dir, id, message) => { await leads.get(dir)!.onMessage(id, message) }),
    ...(options.spaces ? { spacesDir: options.spaces } : { projectDir: context.stores.projectDir }),
    ...(options.port === undefined ? {} : { port: options.port }),
    ...(options.host === undefined ? {} : { host: options.host }),
    ...(dir === undefined ? {} : { webDir: dir }),
    onSpaceAnswer: async (dir, item) => {
      if (!await leads.get(dir)!.onAttention(item)) await resumeAfterAnswer(contexts.find((entry) => entry.stores.projectDir === dir)!, item, activeRuns, withWriteLease)
    },
    ...createRuntimeCatalog(),
  }
  let server: Awaited<ReturnType<typeof createServer>>
  try { server = await createServer(serverOptions) }
  catch (error) { await Promise.all(stops.map((stop) => stop())); throw error }
  if (options.json) printer.data({ url: server.url, projectDir: context.stores.projectDir })
  else printer.text(`${printer.colors.green('✔')} takt 已启动：${server.url}  ${printer.colors.dim(context.stores.projectDir)}`)
  const shutdown = watchShutdown(async () => {
    const runsStop = activeRuns.stop()
    const leadStop = settleAll([...leads.values()].map((lead) => lead.cancelAll()))
    const writesStop = writes.stop()
    await settleAll([runsStop, leadStop, writesStop, ...stops.map((stop) => stop())])
  })
  try { await shutdown.signalled; await shutdown.stop() }
  finally { shutdown.dispose(); await server.close() }

}

/**
 * Web 上回答待办后，在进程内 resume 对应运行。
 * 服务每请求重新 openProject，所以这里用 CLI 启动时加载的 context 也能读到最新状态。
 */
export async function resumeAfterAnswer(
  context: ProjectContext,
  item: AttentionItem,
  activeRuns = new ActiveRuns(),
  writeLease?: WriteLeaseHook,
): Promise<void> {
  const active = activeRuns.start()
  try {
    // resume 抛错时取消写入也可能仍在进行，必须等 active.drain 后才能释放写租约。
    await runWithDrain(
      () => serializeRun(item.runId, async () => {
        const state = await context.stores.runs.get(item.runId)
        if (!state) return
        // 已终结的运行不需要 resume。
        if (state.status === 'succeeded' || state.status === 'failed' || state.status === 'cancelled') return
        await resumeOnce(context, item.runId, { autoApprove: false, json: true, writeLease }, createPrinter(true), (engine) => active.settle(engine, item.runId))
      }),
      () => active.drain(),
    )
  } finally {
    activeRuns.finish(active)
  }
}
