import { isAbsolute, resolve } from 'node:path'
import type { EventStore, ProjectStores, RunState } from '@taktflow/core'
import { createPrinter, type Printer } from '../output.js'
import type { ParsedCli } from '../args.js'
import { parseRunArgs, UsageError } from '../args.js'
import { createRunEngine, loadRuntime, resolveWorkflow, withMock, type ProjectContext } from '../project.js'
import { ProgressFeed, pendingFor, printRunSummary } from '../progress.js'
import { serializeRun } from '../resume-lock.js'
import { readRunOptions, saveRunOptions, type RunCliOptions } from '../run-options.js'

export interface RunOptions {
  project?: string
  harness?: string
  mock?: string
  autoApprove: boolean
  json: boolean
}

/** 包装 events.append 喂进度，runs.create 落盘 CLI 运行选项（agent 执行前就可用）。 */
export function instrument(stores: ProjectStores, feed: ProgressFeed, cliOptions: RunCliOptions): ProjectStores {
  const events: EventStore = {
    append: async (runId, event) => {
      const envelope = await stores.events.append(runId, event)
      feed.consume(envelope, true)
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
  const engine = createRunEngine({ ...context, stores: instrument(context.stores, feed, cliOptions) }, {
    harness: options.harness,
    autoApprove: options.autoApprove,
  })
  const state = await engine.start({ workflow, requirementId: options.req, args })
  return finishOutput(context, printer, state)
}

export async function resumeWorkflow(cli: ParsedCli): Promise<number> {
  const runId = cli.positionals[0]!
  const context = await loadRuntime(cli.options.project)
  const printer = createPrinter(cli.options.json)
  const state = await serializeRun(runId, () => resumeOnce(context, runId, cli.options, printer))
  return finishOutput(context, printer, state)
}

export async function resumeOnce(context: ProjectContext, runId: string, options: RunOptions, printer: Printer): Promise<RunState> {
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
  const engine = createRunEngine({ ...runtime, stores: instrument(runtime.stores, feed, merged) }, {
    harness,
    autoApprove: options.autoApprove,
  })
  return engine.resume(runId, workflow)
}

/** 打印状态摘要 / 待办；--json 时输出单个 RunState。failed/cancelled 用非零退出码。 */
export async function finishOutput(context: ProjectContext, printer: Printer, state: RunState): Promise<number> {
  const pending = pendingFor(await context.stores.attention.list({ pending: true }), state.runId)
  if (printer.json) printer.data({ ...state, attention: pending })
  else printRunSummary(printer, state, pending)
  return state.status === 'failed' || state.status === 'cancelled' ? 1 : 0
}
