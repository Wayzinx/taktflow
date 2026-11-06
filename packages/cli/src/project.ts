import { sha256 } from '@taktflow/core'
import { access, readFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  createEngine, createLessonRecall, learnFromRun,
  openProject,
  validateWorkflow,
  listWorkflowFiles,
  loadPlugins,
  type LoadedPlugins,
  type Engine,
  type EngineDeps,
  type HarnessAdapter,
  type KnowledgeSource,
  type ModelProvider,
  type ProjectStores,
  type WorkflowDefinition,
} from '@taktflow/core'
import { createHarnesses, createMockHarness, loadMockScript, type MockScript } from '@taktflow/harness'
import { createRepoManager } from '@taktflow/sandbox'
import { attachLessons } from '@taktflow/server'
import { knowledgeFromConfig } from './knowledge.js'
import { tsImport } from 'tsx/esm/api'
import { UsageError } from './args.js'
import { normalizeConfig, runtimeProviders, redactConfigError } from './runtime-config.js'
import { loadRuntimeProfiles } from './runtime-profiles.js'

const here = dirname(fileURLToPath(import.meta.url))
/** 仓库根目录：packages/cli/{src,dist} → 上三级。 */
export const repoRoot = resolve(here, '..', '..', '..')
export const templatesDir = join(repoRoot, 'templates')
export const webDir = join(repoRoot, 'packages', 'web', 'dist')

/** 只有存储和配置：req / ws / status / audit / kb 用这个，不碰 workflow。 */
export async function openStores(project: string | undefined): Promise<ProjectStores> {
  try {
    return await openProject(project ?? process.cwd())
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error))
  }
}

export interface ProjectContext {
  stores: ProjectStores
  workflows: WorkflowDefinition[]
  harnesses: Record<string, HarnessAdapter>
  profiles: Awaited<ReturnType<typeof loadRuntimeProfiles>>
  plugins: LoadedPlugins
  providers: Record<string, ModelProvider>
  knowledge: KnowledgeSource[]
  mockScript?: MockScript
}

/** 运行类命令才加载 workflow / harness / knowledge。 */
export async function loadRuntime(project: string | undefined, options: { mock?: string } = {}): Promise<ProjectContext> {
  const stores = await openProject(project ?? process.cwd())
  try {
    stores.config = normalizeConfig(stores.config)
    attachLessons(stores)
    const plugins = await loadProjectPlugins(stores)
    const providers = runtimeProviders(stores.config, plugins.providers)
    const [profiles, workflows] = await Promise.all([loadRuntimeProfiles(stores.paths.agents, plugins.roles), loadWorkflows(stores)])
    for (const workflow of plugins.workflows) {
      if (workflows.some((item) => item.id === workflow.id)) throw new Error(`workflow 名称冲突：${workflow.id}`)
      workflows.push(workflow)
    }
    const mockScript = options.mock === undefined
      ? await readMock(join(stores.taktDir, 'mock.json'))
      : await readMock(resolve(process.cwd(), options.mock), true)
    const harnesses = createHarnesses({ config: stores.config, projectDir: stores.projectDir, providers, mockScript })
    for (const [id, harness] of Object.entries(plugins.harnesses)) {
      if (Object.hasOwn(harnesses, id)) throw new Error(`harness 名称冲突：${id}`)
      Object.defineProperty(harnesses, id, { value: harness, enumerable: true, configurable: true, writable: true })
    }
    const knowledge = mergeKnowledge(stores, plugins)
    return { stores, workflows, harnesses, profiles, knowledge, plugins, providers, ...(mockScript === undefined ? {} : { mockScript }) }
  } catch (error) {
    throw new Error(redactConfigError(stores.config, error))
  }
}

export async function loadProjectPlugins(stores: ProjectStores): Promise<LoadedPlugins> {
  try {
    return await loadPlugins(stores.config, stores.projectDir, (url) => tsImport(url, { parentURL: import.meta.url }))
  } catch (error) {
    throw new Error(redactConfigError(stores.config, error))
  }
}

export function mergeKnowledge(stores: ProjectStores, plugins: LoadedPlugins): KnowledgeSource[] {
  const sources = knowledgeFromConfig(stores)
  for (const source of plugins.knowledge) {
    if (sources.some((item) => item.id === source.id)) throw new Error(`knowledge 名称冲突：${source.id}`)
    sources.push(source)
  }
  return sources
}

/** 指定 mock 文件时只替换 mock，保留 native 和插件实例；serve 恢复运行时用。 */
export async function withMock(context: ProjectContext, mockFile: string | undefined): Promise<ProjectContext> {
  if (mockFile === undefined) return context
  const mockScript = await readMock(mockFile, true)
  return { ...context, harnesses: { ...context.harnesses, mock: createMockHarness(mockScript!) }, mockScript }
}

async function readMock(file: string, required = false): Promise<MockScript | undefined> {
  if (!required) {
    try {
      await access(file)
    } catch {
      return undefined
    }
  }
  try {
    return await loadMockScript(file)
  } catch (error) {
    throw new UsageError(`无法读取 mock 脚本：${file}（${error instanceof Error ? error.message : String(error)}）`)
  }
}

/** 配置文件里的每个文件用 tsx 导入，按 def.id 建表；也允许直接传 workflow 文件路径。 */
async function loadWorkflows(stores: ProjectStores): Promise<WorkflowDefinition[]> {
  const table: WorkflowDefinition[] = []
  const seen = new Set<string>()
  const files = [...new Set([...await listWorkflowFiles(stores.paths), ...stores.config.workflows.map((entry) => isAbsolute(entry) ? entry : resolve(stores.projectDir, entry))])]
  for (const file of files) {
    const definition = await importWorkflow(file)
    if (seen.has(definition.id)) throw new Error(`workflow ID 重复：${definition.id}`)
    seen.add(definition.id)
    table.push(definition)
  }
  return table
}

const workflowRevisions = new WeakMap<WorkflowDefinition, string>()
async function importWorkflow(file: string): Promise<WorkflowDefinition> {
  let namespace: { default?: unknown }
  try {
    namespace = await tsImport(`${pathToFileURL(file).href}?rev=${sha256(await readFile(file))}`, { parentURL: import.meta.url })
  } catch (error) {
    throw new Error(`加载 workflow 失败：${file}（${error instanceof Error ? error.message : String(error)}）`)
  }
  try { validateWorkflow(namespace.default) }
  catch (error) { throw new Error(`workflow 文件 ${file}：${error instanceof Error ? error.message : String(error)}`) }
  workflowRevisions.set(namespace.default, sha256(await readFile(file)))
  return namespace.default
}

/** `<workflowId>` 可以是已注册的 ID，也可以直接是文件路径。 */
export async function resolveWorkflow(context: ProjectContext, idOrPath: string): Promise<WorkflowDefinition> {
  const found = context.workflows.find((workflow) => workflow.id === idOrPath)
  if (found) return found
  if (/[\\/]/.test(idOrPath) || idOrPath.endsWith('.ts')) {
    return importWorkflow(isAbsolute(idOrPath) ? idOrPath : resolve(context.stores.projectDir, idOrPath))
  }
  throw new UsageError(`workflow 不存在：${idOrPath}（已注册：${context.workflows.map((item) => item.id).join(', ') || '无'}）`)
}

export function stageIndex(workflow: WorkflowDefinition): Map<string, string> {
  const index = new Map<string, string>()
  const walk = (nodes: WorkflowDefinition['nodes'], prefix: string, inherited?: string) => {
    for (const node of nodes) {
      const stage = node.stage ?? inherited
      const id = `${prefix}${node.id}`
      if (stage !== undefined) index.set(id, stage)
      if (node.kind === 'loop') walk(node.body, `${id}/`, stage)
    }
  }
  walk(workflow.nodes, '')
  return index
}

export function stageOf(index: Map<string, string>, nodeId: string): string | undefined {
  let current = nodeId
  for (;;) {
    const stage = index.get(current)
    if (stage !== undefined) return stage
    const cut = current.lastIndexOf('/')
    if (cut < 0) return undefined
    current = current.slice(0, cut)
  }
}

export function createRunEngine(
  context: ProjectContext,
  options: { harness?: string; autoApprove?: boolean; now?: () => Date } = {},
): Engine {
  const engineOptions: Parameters<typeof createEngine>[1] = {}
  if (options.harness !== undefined) engineOptions.harnessOverride = options.harness
  if (options.autoApprove !== undefined) engineOptions.autoApprove = options.autoApprove
  if (options.now !== undefined) engineOptions.now = options.now
  const engine = createEngine(engineDependencies(context), engineOptions)
  const finished = async (state: Awaited<ReturnType<Engine['start']>>) => {
    if (['succeeded', 'failed', 'cancelled'].includes(state.status)) await learnFromRun({ stores: context.stores, runId: state.runId })
    return state
  }
  return { ...engine, start: async (input) => finished(await engine.start({ ...input, args: { ...input.args, ...(workflowRevisions.has(input.workflow) ? { workflowRev: workflowRevisions.get(input.workflow) } : {}) } })), resume: async (id, workflow) => finished(await engine.resume(id, workflow)),
    cancel: async (id) => { await engine.cancel(id); const state = await context.stores.runs.get(id); if (state) await finished(state) } }
}

export function engineDependencies(context: ProjectContext): EngineDeps {
  return {
    stores: context.stores,
    harnesses: context.harnesses,
    profiles: context.profiles,
    knowledge: context.knowledge,
    lessons: context.stores.lessons && createLessonRecall({ store: context.stores.lessons, config: context.stores.config.lessons }),
    repos: createRepoManager({ projectDir: context.stores.projectDir, taktDir: context.stores.taktDir, repos: context.stores.config.repos ?? [] }),
    skillsDir: context.stores.paths.skills,
  }
}
