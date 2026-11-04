import { access } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  createEngine,
  loadProfiles,
  openProject,
  type Engine,
  type HarnessAdapter,
  type KnowledgeSource,
  type ProjectStores,
  type WorkflowDefinition,
} from '@taktflow/core'
import { createHarnesses, loadMockScript, type MockScript } from '@taktflow/harness'
import { knowledgeFromConfig } from './knowledge.js'
import { tsImport } from 'tsx/esm/api'
import { UsageError } from './args.js'

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
  profiles: Awaited<ReturnType<typeof loadProfiles>>
  knowledge: KnowledgeSource[]
  mockScript?: MockScript
}

/** 运行类命令才加载 workflow / harness / knowledge。 */
export async function loadRuntime(project: string | undefined, options: { mock?: string } = {}): Promise<ProjectContext> {
  const stores = await openStores(project)
  const [profiles, workflows] = await Promise.all([loadProfiles(stores.taktDir), loadWorkflows(stores)])
  const mockScript = options.mock === undefined
    ? await readMock(join(stores.taktDir, 'mock.json'))
    : await readMock(resolve(process.cwd(), options.mock), true)
  const harnesses = createHarnesses(mockScript === undefined ? {} : { mockScript })
  return { stores, workflows, harnesses, profiles, knowledge: knowledgeFromConfig(stores), ...(mockScript === undefined ? {} : { mockScript }) }
}

/** 指定了 mock 文件时重建 harness 表；serve 恢复运行时用。 */
export async function withMock(context: ProjectContext, mockFile: string | undefined): Promise<ProjectContext> {
  if (mockFile === undefined) return context
  const mockScript = await readMock(mockFile, true)
  return { ...context, harnesses: createHarnesses({ mockScript }), mockScript }
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
  for (const entry of stores.config.workflows) {
    const definition = await importWorkflow(isAbsolute(entry) ? entry : resolve(stores.projectDir, entry))
    if (seen.has(definition.id)) throw new Error(`workflow ID 重复：${definition.id}`)
    seen.add(definition.id)
    table.push(definition)
  }
  return table
}

async function importWorkflow(file: string): Promise<WorkflowDefinition> {
  let namespace: { default?: unknown }
  try {
    namespace = await tsImport(file, { parentURL: import.meta.url })
  } catch (error) {
    throw new Error(`加载 workflow 失败：${file}（${error instanceof Error ? error.message : String(error)}）`)
  }
  const definition = namespace.default as WorkflowDefinition | undefined
  if (!definition || typeof definition !== 'object' || typeof definition.id !== 'string' || !Array.isArray(definition.nodes)) {
    throw new Error(`workflow 文件缺少 default 导出或结构不对：${file}`)
  }
  return definition
}

/** `<workflowId>` 可以是已注册的 ID，也可以直接是文件路径。 */
export async function resolveWorkflow(context: ProjectContext, idOrPath: string): Promise<WorkflowDefinition> {
  const found = context.workflows.find((workflow) => workflow.id === idOrPath)
  if (found) return found
  if (/[\\/]/.test(idOrPath) || idOrPath.endsWith('.ts')) {
    try {
      return await importWorkflow(isAbsolute(idOrPath) ? idOrPath : resolve(context.stores.projectDir, idOrPath))
    } catch (error) {
      throw new UsageError(error instanceof Error ? error.message : String(error))
    }
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
  return createEngine({
    stores: context.stores,
    harnesses: context.harnesses,
    profiles: context.profiles,
    knowledge: context.knowledge,
  }, engineOptions)
}

