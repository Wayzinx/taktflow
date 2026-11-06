import type { WorkspaceStore } from '../interfaces.js'
import type { ReviewRound } from '../types.js'

export interface ReviewWorkspace { store: WorkspaceStore; requirementId: string }
export interface StoredReviewRound { runId: string; nodeId: string; round: ReviewRound }

export async function readReviewRounds(workspace: ReviewWorkspace, runIds: Set<string>): Promise<StoredReviewRound[]> {
  const rounds = new Map<string, StoredReviewRound>()
  for (const artifact of await workspace.store.listArtifacts(workspace.requirementId)) {
    const match = /^reviews\/(.+)\/(?:r\d+-)?round-\d+\.json$/.exec(artifact.path)
    if (!match) continue
    for (const version of [...artifact.versions].sort((a, b) => a.version - b.version)) {
      const producer = version.producedBy
      if (!producer || !runIds.has(producer.runId)) continue
      const bytes = await workspace.store.readArtifact({ workspace: workspace.requirementId, path: artifact.path, version: version.version })
      if (!bytes) throw new Error(`评审记录缺失：${artifact.path} v${version.version}`)
      let round: ReviewRound
      try {
        round = JSON.parse(bytes.toString()) as ReviewRound
        if (!Array.isArray(round.records) || typeof round.passed !== 'boolean' || !Number.isInteger(round.round)
          || round.records.some(record => !Array.isArray(record.issues))) throw new Error('评审轮次结构不合法')
      } catch (cause) { throw new Error(`无法解析评审记录：${artifact.path} v${version.version}`, { cause }) }
      // 同一轮的作者回应会产生新版本；旧格式重做又可能复用 round-1，以记录身份区分。
      const identity = round.revision !== undefined ? [round.revision, round.round] : round.records.map(record => [record.reviewer, record.at, record.round])
      const key = JSON.stringify([producer.runId, match[1], identity])
      rounds.set(key, { runId: producer.runId, nodeId: match[1]!, round })
    }
  }
  return [...rounds.values()].sort((a, b) => a.runId.localeCompare(b.runId) || a.nodeId.localeCompare(b.nodeId)
    || (a.round.seq ?? 0) - (b.round.seq ?? 0) || (a.round.revision ?? 1) - (b.round.revision ?? 1)
    || (a.round.records[0]?.at ?? '').localeCompare(b.round.records[0]?.at ?? '') || a.round.round - b.round.round)
}
