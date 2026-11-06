import type { WorkspaceStore } from '../interfaces.js'
import type { ReviewRound } from '../types.js'
import { readStoredReviewRounds } from '../review/records.js'

export interface ReviewWorkspace { store: WorkspaceStore; requirementId: string }
export interface StoredReviewRound { runId: string; nodeId: string; round: ReviewRound }

export async function readReviewRounds(workspace: ReviewWorkspace, runIds: Set<string>): Promise<StoredReviewRound[]> {
  const artifacts = await workspace.store.listArtifacts(workspace.requirementId)
  const targets = new Map<string, { runId: string; nodeId: string }>()
  for (const artifact of artifacts) {
    const match = /^reviews\/(.+)\/(?:r\d+-)?round-\d+\.json$/.exec(artifact.path)
    if (!match) continue
    for (const version of artifact.versions) {
      const producer = version.producedBy
      if (producer && runIds.has(producer.runId)) targets.set(JSON.stringify([producer.runId, match[1]]), { runId: producer.runId, nodeId: match[1]! })
    }
  }
  const result: StoredReviewRound[] = []
  for (const { runId, nodeId } of [...targets.values()].sort((a, b) => a.runId.localeCompare(b.runId) || a.nodeId.localeCompare(b.nodeId))) {
    for (const round of await readStoredReviewRounds(workspace.store, workspace.requirementId, runId, nodeId, artifacts)) result.push({ runId, nodeId, round })
  }
  return result
}
