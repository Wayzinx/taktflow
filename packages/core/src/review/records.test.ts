import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { initProject } from '../store/project.js'
import type { ReviewRound, RunState, WorkflowSnapshot } from '../types.js'
import { readReviewRounds } from './records.js'
import { reviewDetail } from '../insights/reviews.js'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))) })

it('旧 round-n 文件按修订 1 读取，作者回应更新同轮不重复计数，读模型不写文件', async () => {
  const root = await mkdtemp(join(tmpdir(), 'takt-review-legacy-')); roots.push(root)
  const stores = await initProject(root)
  const requirementId = (await stores.workspaces.createRequirement({ title: '旧评审' })).id
  const ref = await stores.workspaces.writeArtifact({ ref: { workspace: requirementId, path: 'spec.md' }, kind: 'spec', content: 'spec', author: { type: 'system', id: 'test' } })
  const run: RunState = { runId: 'run-legacy', requirementId, workflowId: 'wf', workflowVersion: '1', status: 'succeeded', startedAt: new Date().toISOString(), args: {}, expansions: [],
    nodes: { review: { id: 'review', status: 'succeeded', attempts: 1, outputs: [], result: { passed: true } } } }
  const snapshot: WorkflowSnapshot = { id: 'wf', title: 'wf', version: '1', stages: [], nodes: [{ id: 'review', kind: 'review', title: '评审', needs: [], review: {
    target: ['spec.md'], author: 'dev', reviewers: [{ role: 'qa' }], pass: 'all', maxRounds: 3, onExhausted: 'fail',
  } }] }
  await stores.runs.create(run, snapshot)
  const round: ReviewRound = { round: 1, passed: false, responses: [], revised: [], records: [{ round: 1, reviewer: 'qa', verdict: 'request_changes', summary: '问题',
    issues: [{ id: 'i', severity: 'major', description: '缺少校验' }], artifacts: [ref], at: '2026-01-01T00:00:00Z' }] }
  const save = (round: ReviewRound) => stores.workspaces.writeArtifact({ ref: { workspace: requirementId, path: `reviews/review/round-${round.round}.json` },
    kind: 'review', content: JSON.stringify(round), author: { type: 'system', id: 'test' }, producedBy: { runId: run.runId, nodeId: 'review' } })
  await save(round)
  round.responses = [{ round: 1, reviewer: 'qa', issueId: 'i', action: 'fixed', note: '已修' }]
  await save(round)
  await save({ ...round, round: 2, passed: true, responses: [], records: [{ ...round.records[0]!, round: 2, verdict: 'approve', issues: [], at: '2026-01-02T00:00:00Z' }] })
  const before = await stores.workspaces.listArtifacts(requirementId)
  const rounds = await readReviewRounds(stores, run.runId, 'review')
  expect(rounds.map((round) => [round.revision, round.round, round.seq])).toEqual([[1, 1, 1], [1, 2, 2]])
  expect(rounds[0]?.responses).toHaveLength(1)
  expect((await reviewDetail(stores, run.runId, 'review'))?.facets).toMatchObject({ outcome: 'no_findings', freshness: 'current', coverage: 'full', open: { major: 1 }, observed: { not_observed: 1 } })
  expect(await stores.workspaces.listArtifacts(requirementId)).toEqual(before)
  const originalRead = stores.workspaces.readArtifact.bind(stores.workspaces)
  stores.workspaces.readArtifact = async (ref) => ref.path === 'spec.md' ? undefined : originalRead(ref)
  expect((await reviewDetail(stores, run.runId, 'review'))?.facets).toMatchObject({ coverage: 'partial', freshness: 'unknown' })
})
