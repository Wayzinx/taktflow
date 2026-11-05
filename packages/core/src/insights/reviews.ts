import { join } from 'node:path'
import { readJsonFile } from '../store/fs-utils.js'
import { runDir } from '../store/paths.js'
import type { RuntimeRecord } from '../engine/runtime.js'
import type { NodeDetail, ReviewStatus, ReviewSummary } from '../api.js'
import type { ProjectStores } from '../interfaces.js'
import type { ReviewRound, SnapshotNode } from '../types.js'
import { buildRunGraph } from './graph.js'

function definitions(nodes: SnapshotNode[], prefix = ''): SnapshotNode[] {
  return nodes.flatMap((node) => [{ ...node, id: prefix + node.id }, ...definitions(node.body ?? [], `${prefix}${node.id}/`)])
}

export async function reviewDetail(stores: ProjectStores, runId: string, nodeId: string): Promise<NodeDetail['review']> {
  const [state, snapshot] = await Promise.all([stores.runs.get(runId), stores.runs.getWorkflow(runId)])
  if (!state || !snapshot) return undefined
  const definition = [...definitions(snapshot.nodes), ...state.expansions.flatMap((expansion) => definitions(expansion.nodes ?? []))].find((node) => node.id === nodeId)
  if (!definition?.review) return undefined
  const artifacts = await stores.workspaces.listArtifacts(state.requirementId)
  // 同轮文件在作者回应或人工确认后追加版本；按评审记录身份合并，保留重做前的所有轮次。
  const rounds = new Map<string, ReviewRound>()
  const versions = artifacts.filter((artifact) => artifact.path.startsWith(`reviews/${nodeId}/round-`) && /^round-\d+\.json$/.test(artifact.path.slice(`reviews/${nodeId}/`.length)))
    .flatMap((artifact) => artifact.versions.filter((version) => version.producedBy?.runId === runId && version.producedBy.nodeId === nodeId)
      .map((version) => ({ artifact, version }))).sort((a, b) => a.version.createdAt.localeCompare(b.version.createdAt))
  for (const { artifact, version } of versions) {
    const bytes = await stores.workspaces.readArtifact({ workspace: state.requirementId, path: artifact.path, version: version.version })
    if (!bytes) throw new Error(`评审记录缺失：${artifact.path} v${version.version}`)
    const round = JSON.parse(bytes.toString()) as ReviewRound
    const key = JSON.stringify(round.records)
    rounds.set(key, round)
  }
  const journal = await readJsonFile<RuntimeRecord>(join(runDir(stores.taktDir, runId), 'engine.json'))
  const progress = journal?.reviews?.[nodeId]
  const recorded = progress ? [...(progress.history ?? []), ...progress.rounds] : [...rounds.values()]
  const ns = state.nodes[nodeId]
  const events = await stores.events.read(runId, { nodeId, types: ['review.round', 'review.response', 'review.exhausted', 'rework.started', 'node.started'] })
  const last = events.at(-1)?.type
  let status: ReviewStatus = (ns?.status === 'succeeded' && (ns.result as { passed?: boolean } | undefined)?.passed)
    || (ns?.status === 'skipped' && recorded.at(-1)?.passed) ? 'passed'
    : last === 'rework.started' ? 'reworked' : last === 'review.exhausted' ? 'exhausted'
      : last === 'review.round' && ![...rounds.values()].at(-1)?.passed ? 'revising'
        : ns?.status === 'pending' && !ns.round ? 'pending' : 'in_review'
  if (ns?.status === 'failed') status = 'exhausted'
  return { config: definition.review, rounds: recorded, status }
}

export async function listReviews(stores: ProjectStores, requirementId: string): Promise<ReviewSummary[]> {
  const summaries: ReviewSummary[] = []
  for (const state of await stores.runs.list({ requirementId })) {
    const snapshot = await stores.runs.getWorkflow(state.runId)
    if (!snapshot) continue
    for (const node of buildRunGraph(snapshot, state).nodes.filter((node) => node.kind === 'review')) {
      const detail = await reviewDetail(stores, state.runId, node.id)
      if (!detail) continue
      const latest = detail.rounds.at(-1)
      const events = await stores.events.read(state.runId, { nodeId: node.id, types: ['rework.started'] })
      summaries.push({ runId: state.runId, nodeId: node.id, title: node.title, target: detail.config.target,
        status: detail.status, round: state.nodes[node.id]?.round ?? latest?.round ?? 0, maxRounds: detail.config.maxRounds, reworks: events.length,
        latest: (latest?.records ?? []).map((record) => ({ reviewer: record.reviewer, verdict: record.verdict, score: record.score,
          openIssues: record.issues.filter((issue) => !latest?.responses.some((response) => response.reviewer === record.reviewer && response.issueId === issue.id && response.action === 'fixed')).length })),
      })
    }
  }
  return summaries
}
