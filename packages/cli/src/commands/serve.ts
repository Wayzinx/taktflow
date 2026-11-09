import { loadRuntimeProfiles } from '../runtime-profiles.js'
import { access } from 'node:fs/promises'
import { discoverSpaces, createServer, type LeadMention, type ServerOptions } from '@taktflow/server'
import { RuntimeConfigError, validateHarnessSelector, type AttentionItem, type ProjectStores, type TaktConfig } from '@taktflow/core'
import { createHarnesses } from '@taktflow/harness'
import { createPrinter } from '../output.js'
import { engineDependencies, loadRuntime, webDir, type ProjectContext } from '../project.js'
import { serializeRun } from '../resume-lock.js'
import { resumeOnce } from './run.js'
import { createRuntimeCatalog } from '../catalog.js'
import { createProjectLead, watchLeadEvents } from '../lead.js'
import { validateRuntime } from '../runtime-validation.js'
import { normalizeConfig, runtimeProviders, redactConfigError } from '../runtime-config.js'

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

function liveView<T extends object>(read: () => T): T {
  return new Proxy({} as T, {
    get: (_, key) => Reflect.get(read(), key),
    has: (_, key) => Reflect.has(read(), key),
    ownKeys: () => Reflect.ownKeys(read()),
    getOwnPropertyDescriptor: (_, key) => {
      const descriptor = Object.getOwnPropertyDescriptor(read(), key)
      return descriptor ? { ...descriptor, configurable: true } : undefined
    },
  })
}

/** 注册表在节点取适配器时读最新版本；已取出的适配器、provider 和请求不变。 */
export function liveRuntime(initial: ProjectContext) {
  let current = initial
  const wrap = (read: () => ProjectContext): ProjectContext => ({ ...initial,
    stores: { ...initial.stores, config: liveView(() => read().stores.config) },
    harnesses: liveView(() => read().harnesses), profiles: liveView(() => read().profiles),
    providers: liveView(() => read().providers),
  })
  const context = wrap(() => current)
  function syncNonRuntime(config: TaktConfig) {
    const old = current.stores.config
    current = { ...current, stores: { ...current.stores, config: { ...config,
      providers: old.providers, models: old.models, roles: old.roles, harnesses: old.harnesses, harnessOverrides: old.harnessOverrides,
      lead: { ...config.lead, harness: old.lead?.harness }, route: { ...config.route, harness: old.route?.harness },
      steward: { ...config.steward, harness: old.steward?.harness }, lessons: { ...config.lessons, learner: old.lessons?.learner },
    } } }
  }
  function prepare(config: TaktConfig) {
    const normalized = normalizeConfig(config)
    const providers = runtimeProviders(normalized, initial.plugins.providers)
    const harnesses = createHarnesses({ config: normalized, projectDir: initial.stores.projectDir, providers, mockScript: initial.mockScript })
    for (const [id, harness] of Object.entries(initial.plugins.harnesses)) {
      if (Object.hasOwn(harnesses, id)) throw new Error(`harness 名称冲突：${id}`)
      Object.defineProperty(harnesses, id, { value: harness, enumerable: true, configurable: true })
    }
    const next = { ...current, stores: { ...current.stores, config: normalized }, providers, harnesses }
    for (const selector of [...Object.values(normalized.roles ?? {}), normalized.lead?.harness, normalized.route?.harness, normalized.steward?.harness, normalized.lessons?.learner]) {
      if (selector) validateHarnessSelector(selector, normalized, harnesses)
    }
    let activated = false
    return { context: wrap(() => activated ? current : next), activate() { current = next; activated = true } }
  }
  async function refreshProfiles() {
    const profiles = await loadRuntimeProfiles(current.stores.paths.agents, current.plugins.roles)
    current = { ...current, profiles }
  }
  return { context, syncNonRuntime, prepare, refreshProfiles }
}

export async function createLiveProject(initial: ProjectContext,
  onPresence: Parameters<typeof createProjectLead>[1], invalidate: (projectDir: string) => void) {
  const runtime = liveRuntime(initial)
  const { context } = runtime
  validateRuntime(context, console.warn)
  let lead = await createProjectLead(context, onPresence)
  // 只保留一个事件观察者；旧 Lead 的在途工作继续完成，新消息交给更新后的 Lead。
  const stop = await watchLeadEvents(context, { ...lead,
    onRunEvent: (runId, event) => lead.onRunEvent(runId, event),
    drain: () => lead.drain(),
  })
  const retired = new Set<Promise<void>>()
  return {
    context,
    get lead() { return lead },
    async resolveRuntime(stores: ProjectStores) {
      runtime.syncNonRuntime(stores.config)
      await runtime.refreshProfiles()
      return engineDependencies(context)
    },
    async getCommands(stores: ProjectStores) {
      runtime.syncNonRuntime(stores.config)
      await runtime.refreshProfiles()
      return lead.commands
    },
    async prepareRuntime(config: TaktConfig) {
      try {
        const prepared = runtime.prepare(config)
        const nextLead = await createProjectLead(prepared.context, onPresence)
        return () => {
          const old = lead
          prepared.activate()
          lead = nextLead
          invalidate(context.stores.projectDir)
          const draining = old.drain().catch(error => { console.warn(redactConfigError(config, error)) }).finally(() => { retired.delete(draining) })
          retired.add(draining)
        }
      } catch (error) { throw new RuntimeConfigError(400, `${redactConfigError(config, error)}；请修正运行时配置后重试`) }
    },
    async stop() {
      try { await stop() }
      finally { await Promise.all(retired) }
    },
  }
}

export function liveProjects(initial: ProjectContext[],
  onPresence: (dir: string, id: string, presence: import('@taktflow/core').LeadPresence) => void,
  invalidate: (dir: string) => void) {
  const runtimes = new Map<string, Awaited<ReturnType<typeof createLiveProject>>>()
  const loading = new Map<string, Promise<Awaited<ReturnType<typeof createLiveProject>>>>()
  const seeds = new Map(initial.map(context => [context.stores.projectDir, context]))
  const ensure = (dir: string) => {
    const ready = runtimes.get(dir)
    if (ready) return Promise.resolve(ready)
    let pending = loading.get(dir)
    if (!pending) {
      pending = (async () => {
        const context = seeds.get(dir) ?? await loadRuntime(dir, { warn: console.warn })
        const runtime = await createLiveProject(context, (id, presence) => onPresence(dir, id, presence), invalidate)
        runtimes.set(dir, runtime)
        seeds.delete(dir)
        return runtime
      })().finally(() => { loading.delete(dir) })
      loading.set(dir, pending)
    }
    return pending
  }
  const remove = async (dir: string) => {
    const runtime = await loading.get(dir) ?? runtimes.get(dir)
    if (runtime) { runtimes.delete(dir); await runtime.stop(); invalidate(dir) }
  }
  return { runtimes, ensure, remove, async close() {
    await Promise.allSettled([...loading.values()])
    await Promise.all([...runtimes.keys()].map(remove))
  } }
}

export async function runServe(options: ServeOptions): Promise<void> {
  if (options.project && options.spaces) throw new Error('--project 与 --spaces 不能同时指定')
  const loaded = options.spaces
    ? await Promise.all((await discoverSpaces(options.spaces)).map((stores) => loadRuntime(stores.projectDir, { warn: console.warn })))
    : [await loadRuntime(options.project, { warn: console.warn })]
  const listeners = new Map<string, Set<(presence: import('@taktflow/core').LeadPresence) => void>>()
  const catalog = createRuntimeCatalog()
  const projects = liveProjects(loaded, (dir, id, presence) => {
    for (const send of listeners.get(`${dir}:${id}`) ?? []) send(presence)
  }, catalog.invalidate)
  const { runtimes } = projects
  try { await Promise.all(loaded.map(context => projects.ensure(context.stores.projectDir))) }
  catch (error) { await projects.close(); throw error }
  const projectDir = loaded[0]?.stores.projectDir ?? options.spaces!
  const printer = createPrinter(options.json)
  const dir = await webDirectory()
  if (dir === undefined) {
    printer.warn(`Web 控制台未构建（${webDir} 不存在），先运行 npm run build -w @taktflow/web；API 仍可用。`)
  }
  const serverOptions: ServerOptions = {
    onSpaceLoad: async stores => { await projects.ensure(stores.projectDir) },
    onSpaceUnload: projects.remove,
    onLeadMention: options.onLeadMention,
    onSpaceLeadMention: options.onSpaceLeadMention ?? (options.onLeadMention
      ? (_, id, message) => options.onLeadMention!(id, message)
      : async (dir, id, message) => { await runtimes.get(dir)!.lead.onMessage(id, message) }),
    ...(options.spaces ? { spacesDir: options.spaces } : { projectDir }),
    ...(options.port === undefined ? {} : { port: options.port }),
    ...(options.host === undefined ? {} : { host: options.host }),
    ...(dir === undefined ? {} : { webDir: dir }),
    onSpaceAnswer: async (dir, item) => {
      if (!await runtimes.get(dir)!.lead.onAttention(item)) await resumeAfterAnswer(runtimes.get(dir)!.context, item)
    },
    prepareRuntime: async (stores, config) => {
      const runtime = runtimes.get(stores.projectDir)!
      if (!runtime) throw new RuntimeConfigError(400, '空间运行时未加载；请重新启动 serve 后重试')
      return runtime.prepareRuntime(config)
    },
    resolveRuntime: (stores) => runtimes.get(stores.projectDir)!.resolveRuntime(stores),
    getCommands: (stores) => runtimes.get(stores.projectDir)!.getCommands(stores),
    getLeadPresence: (dir, id) => runtimes.get(dir)!.lead.getPresence(id),
    resendTask: async (dir, id, message, reason) => runtimes.get(dir)?.lead.resendTask(id, message, reason),
    subscribeLead: (dir, id, send) => {
      const key = `${dir}:${id}`
      const bucket = listeners.get(key) ?? new Set()
      bucket.add(send); listeners.set(key, bucket)
      return () => { bucket.delete(send); if (!bucket.size) listeners.delete(key) }
    },
    ...catalog,
  }
  let server: Awaited<ReturnType<typeof createServer>>
  try { server = await createServer(serverOptions) }
  catch (error) { await projects.close(); throw error }
  if (options.json) printer.data({ url: server.url, projectDir })
  else printer.text(`${printer.colors.green('✔')} takt 已启动：${server.url}  ${printer.colors.dim(projectDir)}`)
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
  try { await server.close() } finally { await projects.close() }
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
