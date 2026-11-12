import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { defineWorkflow, review, script } from '../dsl.js'
import { initProject } from '../store/project.js'
import { createEngine } from '../engine/index.js'
import type { AgentProfile, HarnessAdapter, ReviewNodeDef, RunState, WorkflowSnapshot } from '../types.js'
import { computeRiskSnapshot } from '../insights/risks.js'
import { scorecards } from './scorecards.js'
const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))) })
const approve = { verdict: 'approve', summary: '通过', issues: [] }
const changes = { verdict: 'request_changes', summary: '补充', issues: [{ id: 'I1', severity: 'major', description: '缺少空名字规则' }] }

async function reviewRun(verdicts: Array<typeof approve | typeof changes>, patch: Partial<ReviewNodeDef> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'takt-score-review-')); roots.push(root)
  const stores = await initProject(root), requirementId = (await stores.workspaces.createRequirement({ title: '评审口径' })).id
  let calls = 0
  const mock: HarnessAdapter = { id: 'mock', displayName: 'mock', capabilities: { structuredOutput: true }, available: async () => ({ ok: true }), run: async (req) => {
    const round = Number(/按第 (\d+) 轮/.exec(req.prompt)?.[1] ?? 1)
    const value = req.env!.TAKT_ROLE === 'author' ? { responses: ['r1', 'r2'].map((reviewer) => ({ round, reviewer, issueId: 'I1', action: 'fixed', note: '已补充' })) }
      : verdicts[Math.min(Math.floor(calls++ / 2), verdicts.length - 1)]
    return { ok: true, finalText: '', structured: value }
  } }
  const profiles = Object.fromEntries(['author', 'r1', 'r2'].map((role): [string, AgentProfile] => [role, { role, title: role, description: '', instructions: role, harness: { harness: 'mock' }, skills: [], writeScope: ['requirements/**'] }]))
  const workflow = defineWorkflow({ id: 'wf', title: '评审', version: '1', stages: [], nodes: [
    script({ id: 'write', title: '作者', outputs: [{ path: 'spec.md', kind: 'spec' }], run: async (ctx) => { await writeFile(join(ctx.workspaceDir, 'spec.md'), '版本') } }),
    review({ id: 'review', title: '评审', needs: ['write'], target: ['spec.md'], author: { role: 'author' }, reviewers: [{ role: 'r1' }, { role: 'r2' }], maxRounds: 2, onExhausted: 'fail', humanSignoff: true, ...patch }),
  ] })
  const state = await createEngine({ stores, profiles, harnesses: { mock }, knowledge: [] }, { concurrency: 1, autoApprove: true }).start({ requirementId, workflow })
  expect(state.status).toBe('succeeded')
  return { state, card: (await scorecards(stores, { by: 'node' })).find((card) => card.key.nodeId === 'review')! }
}

it('多评审人、人工确认的评审节点第 1 轮通过算一次通过，不被内部 attempts 拉低', async () => {
  const { state, card } = await reviewRun([approve])
  expect(state.nodes.review?.attempts).toBeGreaterThan(1)
  expect(state.nodes.review?.result).toEqual({ passed: true, rounds: 1 })
  expect(card).toMatchObject({ executions: 1, firstPassRate: 1 })
})

it('评审第 1 轮打回、或用完轮次打回上游后才通过，都不算一次通过', async () => {
  expect((await reviewRun([changes, approve])).card.firstPassRate).toBe(0)
  // 打回上游后评审重新开始，state.result.rounds 回到 1，但这次执行之前已经有过不通过的轮次。
  const reworked = await reviewRun([changes, approve], { maxRounds: 1, onExhausted: { rework: 'write' } })
  expect(reworked.state.nodes.review?.result).toEqual({ passed: true, rounds: 1 })
  expect(reworked.card.firstPassRate).toBe(0)
})

it('退化判定要求前后两组都有至少 3 次执行；样本不足只标探索性，不判退化', async () => {
  const root = await mkdtemp(join(tmpdir(), 'takt-score-regress-')); roots.push(root)
  const stores = await initProject(root), req = await stores.workspaces.createRequirement({ title: '退化样本量' })
  const snapshot: WorkflowSnapshot = { id: 'wf', title: 'wf', version: '1', stages: [], nodes: [{ id: 'prd', kind: 'agent', title: 'prd', role: 'pm', needs: [] }] }
  const actor = { type: 'system' as const, id: 'test' }
  let i = 0
  const execute = async (recipeKey: string, good: boolean) => {
    const at = new Date(1700000000000 + i * 1000).toISOString(), runId = `run-${i++}`
    await stores.runs.create({ runId, workflowId: 'wf', workflowVersion: '1', requirementId: req.id, status: 'succeeded', startedAt: at, endedAt: at, args: {}, expansions: [],
      nodes: { prd: { id: 'prd', status: 'succeeded', attempts: good ? 1 : 2, outputs: [], startedAt: at, endedAt: at } } } satisfies RunState, snapshot)
    await stores.events.append(runId, { type: 'node.started', nodeId: 'prd', actor, data: { attempt: 1 } })
    await stores.events.append(runId, { type: 'node.recipe', nodeId: 'prd', actor, data: { workflowId: 'wf', workflowVersion: '1', nodeId: 'prd', kind: 'agent', skills: [{ name: 'prd', hash: recipeKey }], recipeKey } })
    await stores.events.append(runId, { type: 'node.finished', nodeId: 'prd', actor, data: { status: 'succeeded', outputs: [] } })
  }
  await execute('old', true)
  for (const good of [true, false, false, false]) await execute('new', good)
  const views = async () => Promise.all((['node', 'recipe', 'skill'] as const).map(async (by) => (await scorecards(stores, { by })).find((card) => by === 'node' || card.key.recipeKey === 'new' || card.key.skill?.hash === 'new')!.regression))
  for (const regression of await views()) {
    expect(regression).toMatchObject({ suspected: false, exploratory: true })
    expect(regression?.reason).toContain('样本不足')
  }
  expect(computeRiskSnapshot({ requirements: [], runs: [], attention: [], scorecards: await scorecards(stores, { by: 'node' }) }, 'space', new Date())).toEqual([])
  await execute('old', true); await execute('old', true)
  for (const regression of await views()) expect(regression).toMatchObject({ suspected: true, reason: expect.stringContaining('100% → 25%') })
})
