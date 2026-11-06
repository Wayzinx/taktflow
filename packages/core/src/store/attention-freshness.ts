import type { AttentionItem, ProjectStores } from '../interfaces.js'
import type { NodeState } from '../types.js'
import { checkAnswerFreshness } from './attention-rules.js'

export class AttentionStaleError extends Error {
  constructor(reason: string) { super(`待办已过期：${reason}`); this.name = 'AttentionStaleError' }
}

/** 接受和消费回答都检查，避免答复后、恢复前更新产物仍被放行。 */
export async function assertAnswerFreshness(stores: ProjectStores, item: AttentionItem, node?: NodeState): Promise<void> {
  if (item.attempt === undefined && item.subjects === undefined && item.boundTo === undefined) return
  node ??= (await stores.runs.get(item.runId))?.nodes[item.nodeId]
  if (!node) throw new AttentionStaleError('节点不存在')
  const workspaces = [...new Set((item.subjects ?? item.boundTo ?? []).map((ref) => ref.workspace))]
  const latest = (await Promise.all(workspaces.map(async (workspace) =>
    (await stores.workspaces.listArtifacts(workspace)).map((artifact) => ({ workspace, path: artifact.path, version: artifact.versions.at(-1)?.version }))))).flat()
  const result = checkAnswerFreshness(item, node, latest)
  if (!result.ok) throw new AttentionStaleError(result.reason)
}
