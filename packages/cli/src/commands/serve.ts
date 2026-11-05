import { access } from 'node:fs/promises'
import { discoverSpaces, createServer, type LeadMention, type ServerOptions } from '@taktflow/server'
import type { AttentionItem } from '@taktflow/core'
import { createPrinter } from '../output.js'
import { loadRuntime, webDir, type ProjectContext } from '../project.js'
import { serializeRun } from '../resume-lock.js'
import { resumeOnce } from './run.js'
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
  const leads = new Map(await Promise.all(contexts.map(async (context) => [context.stores.projectDir, await createProjectLead(context)] as const)))
  const stops = await Promise.all(contexts.map((context) => watchLeadEvents(context, leads.get(context.stores.projectDir)!)))
  const context = contexts[0]!
  const printer = createPrinter(options.json)
  const dir = await webDirectory()
  if (dir === undefined) {
    printer.warn(`Web 控制台未构建（${webDir} 不存在），先运行 npm run build -w @taktflow/web；API 仍可用。`)
  }
  const serverOptions: ServerOptions = {
    onLeadMention: options.onLeadMention,
    onSpaceLeadMention: options.onSpaceLeadMention ?? (options.onLeadMention
      ? (_, id, message) => options.onLeadMention!(id, message)
      : async (dir, id, message) => { await leads.get(dir)!.onMessage(id, message) }),
    ...(options.spaces ? { spacesDir: options.spaces } : { projectDir: context.stores.projectDir }),
    ...(options.port === undefined ? {} : { port: options.port }),
    ...(options.host === undefined ? {} : { host: options.host }),
    ...(dir === undefined ? {} : { webDir: dir }),
    onSpaceAnswer: async (dir, item) => {
      if (!await leads.get(dir)!.onAttention(item)) await resumeAfterAnswer(contexts.find((entry) => entry.stores.projectDir === dir)!, item)
    },
    ...createRuntimeCatalog(),
  }
  let server: Awaited<ReturnType<typeof createServer>>
  try { server = await createServer(serverOptions) }
  catch (error) { await Promise.all(stops.map((stop) => stop())); throw error }
  if (options.json) printer.data({ url: server.url, projectDir: context.stores.projectDir })
  else printer.text(`${printer.colors.green('✔')} takt 已启动：${server.url}  ${printer.colors.dim(context.stores.projectDir)}`)
  // serve 常驻：等待进程信号，收到后关闭。
  await new Promise<void>((resolve) => {
    const stop = () => {
      process.off('SIGINT', stop)
      process.off('SIGTERM', stop)
      resolve()
    }
    process.on('SIGINT', stop)
    process.on('SIGTERM', stop)
  })
  await server.close()
  await Promise.all(stops.map((stop) => stop()))
}

/**
 * Web 上回答待办后，在进程内 resume 对应运行。
 * 服务每请求重新 openProject，所以这里用 CLI 启动时加载的 context 也能读到最新状态。
 */
export async function resumeAfterAnswer(context: ProjectContext, item: AttentionItem): Promise<void> {
  await serializeRun(item.runId, async () => {
    const state = await context.stores.runs.get(item.runId)
    if (!state) return
    // 已终结的运行不需要 resume。
    if (state.status === 'succeeded' || state.status === 'failed' || state.status === 'cancelled') return
    await resumeOnce(context, item.runId, { autoApprove: false, json: true }, createPrinter(true))
  })
}
