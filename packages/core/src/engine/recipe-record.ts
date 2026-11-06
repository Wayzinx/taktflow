import { structuredLog, parseStructuredLog } from '../util/structured-log.js'
import type { ArtifactRef, EventEnvelope, EventPayloads, SnapshotNode } from '../types.js'

// 暂用 log 承载扩展信息，协议升级前只允许本模块编码/解码，保留旧输入记录兼容。
export interface RecipeInputs {
  kind: 'node.recipe.inputs'
  refs: ArtifactRef[]
  prompt?: string
  resultSchema?: Record<string, unknown>
}
export type FrozenNode = SnapshotNode & { resultSchema?: Record<string, unknown>; replayPromptKind?: 'template' | 'assembled-legacy' }
export function recipeInputsLog(refs: ArtifactRef[], prompt?: string, resultSchema?: Record<string, unknown>): EventPayloads['log'] {
  return structuredLog({ kind: 'node.recipe.inputs', refs, prompt, resultSchema } satisfies RecipeInputs)
}
export function readRecipeInputs(events: EventEnvelope[]): RecipeInputs | undefined {
  for (const event of events) {
    if (event.type !== 'log') continue
    try {
      const data = parseStructuredLog(event.data as EventPayloads['log']) as RecipeInputs | undefined
      if (data?.kind === 'node.recipe.inputs' && Array.isArray(data.refs) && data.refs.every((ref) => typeof ref?.path === 'string' && typeof ref.workspace === 'string')) return data
    } catch { /* 普通日志不属于配方记录。 */ }
  }
  return undefined
}
