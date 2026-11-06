import { join } from 'node:path'
import { parseStructuredLog } from '../util/structured-log.js'
import { sha256 } from '../util/hash.js'
import { assertNoSymlinks, readJsonFile, toJsonText, writeFileAtomic } from '../store/fs-utils.js'
import { runDir } from '../store/paths.js'
import type { ProjectStores } from '../interfaces.js'
import type { ArtifactRef, EventEnvelope, EventPayloads, NodeRecipe, SnapshotNode } from '../types.js'

// 旧事件只读兼容；新输入直接读取 node.recipe，模板与 schema 单独冻结以避免回放重复组装 prompt。
export interface RecipeInputs {
  kind: 'node.recipe.inputs'
  refs: ArtifactRef[]
  prompt?: string
  resultSchema?: Record<string, unknown>
}
export type FrozenNode = SnapshotNode & { resultSchema?: Record<string, unknown>; replayPromptKind?: 'template' | 'assembled-legacy' }
export function readRecipeInputs(events: EventEnvelope[]): RecipeInputs | undefined {
  for (const event of events) {
    if (event.type === 'node.recipe') {
      const recipe = event.data as NodeRecipe
      if (recipe.inputs !== undefined) return { kind: 'node.recipe.inputs', refs: recipe.inputs }
    }
    if (event.type !== 'log') continue
    try {
      const data = parseStructuredLog(event.data as EventPayloads['log']) as RecipeInputs | undefined
      if (data?.kind === 'node.recipe.inputs' && Array.isArray(data.refs) && data.refs.every((ref) => typeof ref?.path === 'string' && typeof ref.workspace === 'string')) return data
    } catch { /* 普通日志不属于配方记录。 */ }
  }
  return undefined
}

type RecipeContext = Pick<RecipeInputs, 'prompt' | 'resultSchema'>
function contextFile(stores: ProjectStores, runId: string, nodeId: string, startSeq: number, key: string): string {
  return join(runDir(stores.taktDir, runId), 'recipe-context', `${sha256(nodeId)}-${startSeq}-${sha256(key)}.json`)
}
export async function saveRecipeContext(stores: ProjectStores, runId: string, nodeId: string, startSeq: number, key: string, value: RecipeContext): Promise<void> {
  const file = contextFile(stores, runId, nodeId, startSeq, key)
  await assertNoSymlinks(stores.taktDir, file)
  await writeFileAtomic(file, toJsonText(value))
}
export async function readRecipeContext(stores: ProjectStores, runId: string, nodeId: string, events: EventEnvelope[]): Promise<RecipeContext | undefined> {
  const recipe = events.find((event) => event.type === 'node.recipe')
  if (!recipe) return undefined
  const start = events.filter((event) => event.type === 'node.started' && event.seq < recipe.seq).at(-1)
  const file = contextFile(stores, runId, nodeId, start?.seq ?? 0, (recipe.data as NodeRecipe).recipeKey)
  await assertNoSymlinks(stores.taktDir, file)
  return readJsonFile<RecipeContext>(file)
}
