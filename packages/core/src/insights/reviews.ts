import { join } from 'node:path'
import { readJsonFile } from '../store/fs-utils.js'
import { runDir } from '../store/paths.js'
import type { RuntimeRecord } from '../engine/runtime.js'
import type { NodeDetail, ReviewFacets, ReviewStatus, ReviewSummary } from '../api.js'
import type { ProjectStores } from '../interfaces.js'
import type { ArtifactRef, ReviewDisposition, ReviewIssue, ReviewRound, RunState, SnapshotNode } from '../types.js'
import { buildRunGraph } from './graph.js'
import { readReviewRounds } from '../review/records.js'
import { listReviewDispositions } from '../review/dispositions.js'
import { targetFingerprint } from '../engine/nodes/review-target.js'
import { diffPath, executionAdapters } from '../engine/execution.js'
import { matchGlob } from '../util/glob.js'
import { sha256 } from '../util/hash.js'

function definitions(nodes: SnapshotNode[], prefix = ''): SnapshotNode[] {
  return nodes.flatMap((node) => [{ ...node, id: prefix + node.id }, ...definitions(node.body ?? [], `${prefix}${node.id}/`)])
}

function latestIssues(rounds: ReviewRound[]): Map<string, ReviewIssue> {
  return new Map(rounds.flatMap((round) => round.records.flatMap((record) => record.issues.map((issue) => [issue.groupKey!, issue] as const))))
}

function isOpen(issue: ReviewIssue, dispositions: ReviewDisposition[]): boolean {
  const disposition = dispositions.find((item) => item.groupKey === issue.groupKey)
  return !disposition || disposition.stale === true || disposition.fingerprint !== issue.fingerprint || disposition.state === 'open'
}

async function targetState(stores: ProjectStores, state: RunState, config: NonNullable<SnapshotNode['review']>, latest: ReviewRound | undefined, diffs: Map<string, Promise<string>>): Promise<{
  readable: boolean; freshness: ReviewFacets['freshness']
}> {
  if (!latest) return { readable: false, freshness: 'unknown' }
  const refs = [...new Map(latest.records.flatMap((record) => record.artifacts).map((ref) => [ref.path, ref])).values()]
  if (!refs.length) return { readable: false, freshness: 'unknown' }
  const readable = (await Promise.all(refs.map((ref) => stores.workspaces.readArtifact(ref)))).every((bytes) => bytes !== undefined)
  const artifacts = await stores.workspaces.listArtifacts(state.requirementId)
  const target = config.target
  const current: ArtifactRef[] = Array.isArray(target)
    ? artifacts.filter((artifact) => target.some((pattern) => matchGlob(pattern, artifact.path)))
      .map((artifact) => ({ workspace: state.requirementId, path: artifact.path, version: artifact.versions.at(-1)?.version }))
    : refs.map((ref) => ({ ...ref, version: artifacts.find((artifact) => artifact.path === ref.path)?.versions.at(-1)?.version }))
  const complete = readable && current.length > 0 && current.every((ref) => ref.version !== undefined)
    && (!Array.isArray(target) || target.every((pattern) => current.some((ref) => matchGlob(pattern, ref.path))))
  if (!complete) return { readable: false, freshness: 'unknown' }
  const before = latest.targetFingerprint ?? (refs.every((ref) => ref.version !== undefined)
    ? await targetFingerprint(stores.workspaces, refs, !Array.isArray(target)) : undefined)
  if (!before) return { readable, freshness: 'unknown' }
  let now: string
  if (!Array.isArray(target)) {
    const sources = Object.values(state.nodes).filter((node) => node.worktree?.repo === target.code.repo
      && refs.some((ref) => ref.path === diffPath(node.id)))
    if (sources.length) {
      // 读取实时 diff，不登记新产物；读模型不能改变被评审对象的版本。
      try {
        const { createRepoManager } = await executionAdapters()
        const repos = createRepoManager({ projectDir: stores.projectDir, taktDir: stores.taktDir, repos: stores.config.repos ?? [] })
        const patches: string[] = []
        for (const ref of [...current].sort((a, b) => a.path.localeCompare(b.path))) {
          const source = sources.find((node) => diffPath(node.id) === ref.path)
          if (!source?.worktree) return { readable, freshness: 'unknown' }
          const key = JSON.stringify([source.worktree.path, target.code.base ?? source.worktree.base])
          if (!diffs.has(key)) diffs.set(key, repos.diff(source.worktree.path, target.code.base ?? source.worktree.base).then((diff) => diff.patch))
          const patch = await diffs.get(key)!
          patches.push(patch.split(/(?=^diff --git )/m).filter((chunk) => !/^diff --git "?a\/\.(agents|claude)\/skills\//.test(chunk)).join(''))
        }
        now = sha256(patches.join('\n'))
      } catch { return { readable, freshness: 'unknown' } }
    } else now = await targetFingerprint(stores.workspaces, current, true)
  } else now = await targetFingerprint(stores.workspaces, current, false)
  return { readable, freshness: before === now ? 'current' : 'stale' }
}

export async function reviewDetail(stores: ProjectStores, runId: string, nodeId: string, diffs = new Map<string, Promise<string>>()): Promise<(NonNullable<NodeDetail['review']> & { revision: number }) | undefined> {
  const [state, snapshot] = await Promise.all([stores.runs.get(runId), stores.runs.getWorkflow(runId)])
  if (!state || !snapshot) return undefined
  const definition = [...definitions(snapshot.nodes), ...state.expansions.flatMap((expansion) => definitions(expansion.nodes ?? []))].find((node) => node.id === nodeId)
  if (!definition?.review) return undefined
  const stored = await readReviewRounds(stores, runId, nodeId)
  const journal = await readJsonFile<RuntimeRecord>(join(runDir(stores.taktDir, runId), 'engine.json'))
  const progress = journal?.reviews?.[nodeId]
  const rounds = stored
  const ns = state.nodes[nodeId]
  const latest = rounds.at(-1)
  const events = await stores.events.read(runId, { nodeId, types: ['review.round', 'review.response', 'review.exhausted', 'rework.started', 'node.started'] })
  const last = events.at(-1)?.type
  let status: ReviewStatus = (ns?.status === 'succeeded' && (ns.result as { passed?: boolean } | undefined)?.passed)
    || (ns?.status === 'skipped' && latest?.passed) ? 'passed'
    : last === 'rework.started' ? 'reworked' : last === 'review.exhausted' ? 'exhausted'
      : progress?.phase === 'revise' ? 'revising'
        : ns?.status === 'pending' && !ns.round ? 'pending' : 'in_review'
  if (ns?.status === 'failed') status = 'exhausted'
  const phase: ReviewFacets['phase'] = ns?.status === 'failed' ? 'failed' : status === 'reworked' ? 'reworked'
    : status === 'passed' ? 'done' : progress?.phase === 'signoff' ? 'signoff'
      : progress?.phase === 'exhausted' || progress?.phase === 'decision' || status === 'exhausted' ? 'exhausted'
        : status === 'revising' ? 'revising' : status === 'pending' ? 'pending' : 'reviewing'
  const dispositions = await listReviewDispositions(stores, runId, nodeId)
  const open: ReviewFacets['open'] = { blocker: 0, major: 0, minor: 0, nit: 0 }
  for (const issue of latestIssues(rounds).values()) if (isOpen(issue, dispositions)) open[issue.severity]++
  const observed: NonNullable<ReviewFacets['observed']> = {}
  for (const item of latest?.continuity ?? []) {
    observed[item.observation] = (observed[item.observation] ?? 0) + 1
    if (item.regressed) observed.regressed = (observed.regressed ?? 0) + 1
  }
  const target = await targetState(stores, state, definition.review, latest, diffs)
  const facets: ReviewFacets = {
    phase, outcome: !latest ? undefined : latest.passed ? latest.records.some((record) => record.issues.length) ? 'approved' : 'no_findings'
      : latest.records.some((record) => record.verdict === 'reject') ? 'rejected'
        : phase === 'exhausted' || status === 'exhausted' || phase === 'reworked' || last === 'review.exhausted' ? 'escalated' : 'changes_requested',
    coverage: target.readable && definition.review.reviewers.every((reviewer) => latest?.records.some((record) => !record.arbiter && record.reviewer === reviewer.role)) ? 'full' : 'partial',
    freshness: target.freshness, open, observed,
  }
  return { config: definition.review, rounds, status, revision: ns?.revision ?? latest?.revision ?? 1, facets, dispositions }
}

export async function listReviews(stores: ProjectStores, requirementId: string): Promise<ReviewSummary[]> {
  const summaries: ReviewSummary[] = []
  const diffs = new Map<string, Promise<string>>()
  for (const state of await stores.runs.list({ requirementId })) {
    const snapshot = await stores.runs.getWorkflow(state.runId)
    if (!snapshot) continue
    for (const node of buildRunGraph(snapshot, state).nodes.filter((node) => node.kind === 'review')) {
      const detail = await reviewDetail(stores, state.runId, node.id, diffs)
      if (!detail) continue
      const latest = detail.rounds.at(-1)
      const events = await stores.events.read(state.runId, { nodeId: node.id, types: ['rework.started'] })
      summaries.push({ runId: state.runId, nodeId: node.id, title: node.title, target: detail.config.target,
        status: detail.status, round: state.nodes[node.id]?.round ?? latest?.round ?? 0, maxRounds: detail.config.maxRounds, reworks: events.length,
        revision: detail.revision, facets: detail.facets,
        latest: (latest?.records ?? []).map((record) => ({ reviewer: record.reviewer, verdict: record.verdict, score: record.score,
          openIssues: record.issues.filter((issue) => isOpen(issue, detail.dispositions ?? [])).length })),
      })
    }
  }
  return summaries
}
