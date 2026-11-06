import type { AttentionItem, ProjectStores } from '../interfaces.js'
import type { ArtifactRef } from '../types.js'
import { checkAnswerFreshness } from '../store/attention-rules.js'

export async function withAttentionStaleness(stores: ProjectStores, items: AttentionItem[]): Promise<AttentionItem[]> {
  const latest: ArtifactRef[] = []
  for (const workspace of new Set(items.flatMap((item) => (item.subjects ?? item.boundTo ?? []).map((ref) => ref.workspace)))) {
    latest.push(...(await stores.workspaces.listArtifacts(workspace)).map((artifact) => ({ workspace, path: artifact.path, version: artifact.versions.at(-1)?.version })))
  }
  const runs = new Map(await Promise.all([...new Set(items.map((item) => item.runId))].map(async (id) => [id, await stores.runs.get(id)] as const)))
  return items.map((item) => {
    if (item.attempt === undefined && item.subjects === undefined && item.boundTo === undefined) return { ...item, stale: false }
    const node = runs.get(item.runId)?.nodes[item.nodeId]
    return { ...item, stale: !node || !checkAnswerFreshness(item, node, latest).ok }
  })
}
