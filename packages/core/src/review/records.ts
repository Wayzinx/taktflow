import { join } from 'node:path'
import { readJsonFile } from '../store/fs-utils.js'
import { runDir } from '../store/paths.js'
import type { ReviewProgress } from '../engine/nodes/review.js'
import type { ProjectStores } from '../interfaces.js'
import type { ReviewRound } from '../types.js'
import { reviewContinuity } from '../engine/nodes/review-continuity.js'

// 旧记录每次打回都会从 round=1 开始；读取时补齐修订、序号，不改历史文件。
export function normalizeRounds(rounds: ReviewRound[]): ReviewRound[] {
  let revision = 1
  let seq = 0
  let prior: ReviewRound | undefined
  return rounds.map((value) => {
    const round = structuredClone(value)
    revision = round.revision ?? (prior && round.round <= prior.round ? revision + 1 : revision)
    round.revision = revision
    round.seq ??= seq + 1
    seq = round.seq
    const continuity = reviewContinuity(round, prior)
    round.continuity ??= continuity
    prior = round
    return round
  })
}

export async function readReviewRounds(stores: ProjectStores, runId: string, nodeId: string): Promise<ReviewRound[]> {
  const run = await stores.runs.get(runId)
  if (!run) throw new Error(`运行不存在：${runId}`)
  const prefix = `reviews/${nodeId}/`
  const artifacts = await stores.workspaces.listArtifacts(run.requirementId)
  const versions = artifacts.filter((artifact) => artifact.path.startsWith(prefix)
    && /^(?:r\d+-)?round-\d+\.json$/.test(artifact.path.slice(prefix.length)))
    .flatMap((artifact) => artifact.versions.filter((version) => version.producedBy?.runId === runId && version.producedBy.nodeId === nodeId)
      .map((version) => ({ artifact, version }))).sort((a, b) => a.version.createdAt.localeCompare(b.version.createdAt))
  const rounds = new Map<string, ReviewRound>()
  for (const { artifact, version } of versions) {
    const bytes = await stores.workspaces.readArtifact({ workspace: run.requirementId, path: artifact.path, version: version.version })
    if (!bytes) throw new Error(`评审记录缺失：${artifact.path} v${version.version}`)
    const round = JSON.parse(bytes.toString()) as ReviewRound
    const key = round.revision === undefined ? JSON.stringify(round.records) : `${round.revision}:${round.round}`
    rounds.set(key, round)
  }
  // 相同内容跨运行会复用产物版本；运行日志仍保留当前运行的评审身份。
  const journal = await readJsonFile<{ reviews?: Record<string, ReviewProgress> }>(join(runDir(stores.taktDir, runId), 'engine.json'))
  const progress = journal?.reviews?.[nodeId]
  if (progress) return normalizeRounds([...(progress.history ?? []), ...progress.rounds])
  return normalizeRounds([...rounds.values()].sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0)
    || (a.revision ?? 1) - (b.revision ?? 1) || (a.revision && b.revision ? a.round - b.round : 0)))
}
