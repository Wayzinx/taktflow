import { access } from 'node:fs/promises'
import { createServer } from '@taktflow/server'
import type { AttentionItem } from '@taktflow/core'
import { createPrinter } from '../output.js'
import { loadRuntime, webDir, type ProjectContext } from '../project.js'
import { serializeRun } from '../resume-lock.js'
import { resumeOnce } from './run.js'

export interface ServeOptions {
  project?: string
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
  const context = await loadRuntime(options.project)
  const printer = createPrinter(options.json)
  const dir = await webDirectory()
  if (dir === undefined) {
    printer.warn(`Web 控制台未构建（${webDir} 不存在），先运行 npm run build -w @taktflow/web；API 仍可用。`)
  }
  const server = await createServer({
    projectDir: context.stores.projectDir,
    ...(options.port === undefined ? {} : { port: options.port }),
    ...(options.host === undefined ? {} : { host: options.host }),
    ...(dir === undefined ? {} : { webDir: dir }),
    onAnswer: (item) => resumeAfterAnswer(context, item),
  })
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
