import { assertAnswerFreshness } from '../store/attention-freshness.js'
import { withAttentionStaleness } from '../insights/attention.js'
import type { AttentionItem } from '../interfaces.js'
import { join } from 'node:path'
import type { ProjectStores } from '../interfaces.js'
import type { Actor, ReviewDisposition } from '../types.js'
import { withFileLock } from '../store/file-lock.js'
import { assertNodeId, runDir } from '../store/paths.js'
import { sha256 } from '../util/hash.js'
import { readReviewRounds } from './records.js'

async function history(stores: ProjectStores, runId: string, nodeId: string): Promise<ReviewDisposition[]> {
  const run = await stores.runs.get(runId)
  if (!run) throw new Error(`运行不存在：${runId}`)
  assertNodeId(nodeId)
  const path = `reviews/${nodeId}/dispositions.json`
  const artifact = (await stores.workspaces.listArtifacts(run.requirementId)).find((item) => item.path === path)
  const version = artifact?.versions.filter((item) => item.producedBy?.runId === runId && item.producedBy.nodeId === nodeId).at(-1)
  if (!version) return []
  const bytes = await stores.workspaces.readArtifact({ workspace: run.requirementId, path, version: version.version })
  if (!bytes) throw new Error(`评审处置记录缺失：${path} v${version.version}`)
  return JSON.parse(bytes.toString()) as ReviewDisposition[]
}

export async function listReviewDispositions(stores: ProjectStores, runId: string, nodeId: string): Promise<ReviewDisposition[]> {
  const items = [...new Map((await history(stores, runId, nodeId)).map((item) => [item.groupKey, item])).values()]
  const requirementId = (await stores.runs.get(runId))!.requirementId
  const freshness = await withAttentionStaleness(stores, items.map((item) => binding(item, runId, nodeId, requirementId)))
  return items.map((item, index) => ({ ...item, stale: freshness[index]!.stale }))
}

export async function setReviewDisposition(stores: ProjectStores, runId: string, nodeId: string,
  input: { groupKey: string; state: ReviewDisposition['state']; reason: string; by: Actor }): Promise<ReviewDisposition> {
  if (input.by.type !== 'human') throw new Error('评审处置必须使用 human actor')
  if (!input.reason.trim()) throw new Error('评审处置必须填写原因')
  if (!['open', 'resolved', 'dismissed'].includes(input.state)) throw new Error('未知评审处置状态')
  assertNodeId(nodeId)
  return withFileLock(join(runDir(stores.taktDir, runId), `review-disposition-${sha256(nodeId)}`), async () => {
    const run = await stores.runs.get(runId)
    if (!run) throw new Error(`运行不存在：${runId}`)
    const rounds = await readReviewRounds(stores, runId, nodeId)
    const selected = rounds.flatMap((round) => round.records.flatMap((record) => record.issues.map((issue) => ({ issue, record, round }))))
      .filter(({ issue }) => issue.groupKey === input.groupKey).at(-1)
    if (!selected) throw new Error(`评审问题不存在：${input.groupKey}`)
    const disposition: ReviewDisposition = { ...input, at: new Date().toISOString(), fingerprint: selected.issue.fingerprint,
      attempt: run.nodes[nodeId]?.attempts, subjects: selected.record.artifacts.map((ref) => ({ ...ref })) }
    await assertAnswerFreshness(stores, binding(disposition, runId, nodeId, run.requirementId), run.nodes[nodeId])
    const entries = [...await history(stores, runId, nodeId), disposition]
    await stores.workspaces.writeArtifact({ ref: { workspace: run.requirementId, path: `reviews/${nodeId}/dispositions.json` },
      content: JSON.stringify(entries, null, 2), kind: 'review', author: input.by, reason: input.reason,
      producedBy: { runId, nodeId } })
    await stores.events.append(runId, { type: 'review.disposition', actor: input.by, nodeId, data: disposition })
    return disposition
  })
}

function binding(item: ReviewDisposition, runId: string, nodeId: string, requirementId: string): AttentionItem {
  return { requestId: item.groupKey, runId, nodeId, requirementId, ask: item.reason, form: 'approve', createdAt: item.at,
    attempt: item.attempt, subjects: item.subjects }
}
