import type { AttentionItem, ProjectStores } from '../interfaces.js'
import type { ArtifactRecord } from '../types.js'

export async function withAttentionStaleness(stores: ProjectStores, items: AttentionItem[]): Promise<AttentionItem[]> {
  const workspaces = new Map<string, ArtifactRecord[]>()
  for (const id of new Set(items.flatMap((item) => (item.boundTo ?? []).map((ref) => ref.workspace)))) {
    workspaces.set(id, await stores.workspaces.listArtifacts(id))
  }
  return items.map((item) => ({ ...item, stale: (item.boundTo ?? []).some((ref) => {
    const latest = workspaces.get(ref.workspace)?.find((artifact) => artifact.path === ref.path)?.versions.at(-1)
    return ref.version !== undefined && latest !== undefined && latest.version > ref.version
  }) }))
}
