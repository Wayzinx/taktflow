import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { initProject } from '../store/project.js'
import { createEngine } from '../engine/index.js'
import type { AgentProfile, HarnessAdapter, NodeRecipe, RunState, WorkflowSnapshot } from '../types.js'
import { collectCases, listEvalCases } from './cases.js'
import { scorecards } from './scorecards.js'
const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))) })

it('被评审打回的执行冻结首次输入与最终通过版本；角色各记一条配方；人工语义修改进入用例集', async () => {
  const root = await mkdtemp(join(tmpdir(), 'takt-eval-history-')); roots.push(root)
  const stores = await initProject(root), req = await stores.workspaces.createRequirement({ title: '历史收集' })
  const actor = { type: 'human' as const, id: 'tester' }
  const input = await stores.workspaces.writeArtifact({ ref: { workspace: req.id, path: 'input/spec.md' }, kind: 'input', content: 'frozen v1', author: actor, reason: '输入' })
  const profiles: Record<string, AgentProfile> = Object.fromEntries(['dev', 'reviewer', 'reviewer2', 'arbiter'].map((role) => [role, {
    role, title: role, description: '', instructions: role, harness: { harness: 'mock', model: role }, skills: [], writeScope: ['**'],
  }]))
  let reviews = 0
  const harness: HarnessAdapter = { id: 'mock', displayName: 'mock', available: async () => ({ ok: true }), async run(request) {
    const role = request.env!.TAKT_ROLE, node = request.env!.TAKT_NODE
    let value: unknown
    if (role === 'reviewer' || role === 'reviewer2' || role === 'arbiter') {
      if (role === 'reviewer') reviews++
      const bad = reviews === 1 && role !== 'reviewer2'
      value = { verdict: bad ? 'request_changes' : 'approve', summary: '检查输出', issues: bad ? [{ id: 'I-1', severity: 'blocker', description: '输出错误' }] : [] }
    } else {
      const file = join(request.env!.TAKT_WORKSPACE!, 'spec/result.md')
      await mkdir(dirname(file), { recursive: true }); await writeFile(file, node === 'produce' ? 'bad' : 'GOOD reviewed')
      value = node === 'produce' ? { summary: '初版' } : { responses: ['reviewer', 'arbiter'].map((reviewer) => ({ round: 1, reviewer, issueId: 'I-1', action: 'fixed', note: '已修复' })) }
    }
    return { ok: true, finalText: JSON.stringify(value), structured: value }
  } }
  const run = await createEngine({ stores, profiles, harnesses: { mock: harness }, knowledge: [] }).start({ requirementId: req.id,
    workflow: { id: 'reviewed', title: 'reviewed', version: '1', stages: [], nodes: [
      { id: 'produce', kind: 'agent', title: '产出', role: 'dev', prompt: '写输出', inputs: [{ path: input.path }], outputs: [{ path: 'spec/result.md', kind: 'spec' }] },
      { id: 'review', kind: 'review', title: '评审', needs: ['produce'], target: ['spec/result.md'], author: { role: 'dev' }, reviewers: [{ role: 'reviewer' }, { role: 'reviewer2' }], arbiter: { role: 'arbiter' }, maxRounds: 2, onExhausted: 'fail' },
    ] } })
  expect(run.status).toBe('succeeded')
  const recipes = (await stores.events.read(run.runId)).filter((e) => e.type === 'node.recipe' && e.nodeId === 'review').map((e) => e.data as NodeRecipe)
  expect(recipes.map((recipe) => recipe.role).sort()).toEqual(['arbiter', 'dev', 'reviewer', 'reviewer2'])
  expect(recipes.every((recipe) => recipe.kind === 'review')).toBe(true)
  await stores.workspaces.writeArtifact({ ref: { workspace: req.id, path: input.path }, kind: 'input', content: 'changed v2', author: actor, reason: '修改输入' })
  const result = await collectCases(stores, {})
  expect(result.added).toHaveLength(1)
  const cases = await listEvalCases(stores)
  expect(cases[0]).toMatchObject({ inputs: [{ path: 'input/spec.md', content: 'frozen v1' }], grading: { reference: { content: 'GOOD reviewed' } } })
  const cards = await scorecards(stores, { by: 'node' })
  expect(cards.find((card) => card.key.nodeId === 'produce')?.review).toMatchObject({ roundsAvg: 2, reworks: 1, issues: { blocker: 2 } })
  const edited = await stores.workspaces.writeArtifact({ ref: { workspace: req.id, path: 'spec/result.md' }, kind: 'spec', content: 'human final', author: actor, reason: '语义修正' })
  await stores.events.append(run.runId, { type: 'artifact.edited', actor, data: { ref: edited, reason: '语义修正', impact: 'semantic' } })
  await collectCases(stores, {})
  expect((await listEvalCases(stores))[0]?.grading.reference?.content).toBe('GOOD reviewed')

})

it('配方/技能退化按至少三次执行且下降超过20个百分点判定，完成标准失败不算一次通过', async () => {
  const root = await mkdtemp(join(tmpdir(), 'takt-eval-score-')); roots.push(root)
  const stores = await initProject(root), req = await stores.workspaces.createRequirement({ title: '退化统计' })
  const snapshot: WorkflowSnapshot = { id: 'wf', title: 'wf', version: '1', stages: [], nodes: [{ id: 'dev', kind: 'agent', title: 'dev', role: 'dev', needs: [], completion: ['证据充分'] }] }
  for (let i = 0; i < 6; i++) {
    const at = new Date(1700000000000 + i * 1000).toISOString(), good = i < 3
    const state: RunState = { runId: `run-${i}`, workflowId: 'wf', workflowVersion: '1', requirementId: req.id, status: good ? 'succeeded' : 'failed', startedAt: at, endedAt: at, args: {}, expansions: [], nodes: { dev: { id: 'dev', status: good ? 'succeeded' : 'failed', attempts: 1, outputs: [], startedAt: at, endedAt: at } } }
    await stores.runs.create(state, snapshot)
    const actor = { type: 'system' as const, id: 'test' }
    await stores.events.append(state.runId, { type: 'node.started', nodeId: 'dev', actor, data: { attempt: 1 } })
    await stores.events.append(state.runId, { type: 'node.recipe', nodeId: 'dev', actor, data: { workflowId: 'wf', workflowVersion: '1', nodeId: 'dev', kind: 'agent', skills: [{ name: 'design', hash: good ? 'old' : 'new' }], recipeKey: good ? 'old' : 'new' } })
    await stores.events.append(state.runId, { type: 'node.checks', nodeId: 'dev', actor, data: { checks: [{ id: 'c1', criterion: '证据充分', pass: good, evidence: good ? '结果' : '' }], unmet: good ? [] : ['c1'] } })
    await stores.events.append(state.runId, { type: 'node.finished', nodeId: 'dev', actor, data: { status: good ? 'succeeded' : 'failed', outputs: [], usage: { inputTokens: 10, outputTokens: 5 } } })
  }
  const node = (await scorecards(stores, { by: 'node' }))[0]!
  expect(node).toMatchObject({ executions: 6, firstPassRate: 0.5, completionUnmet: 3, usage: { inputTokens: 60, outputTokens: 30 }, regression: { suspected: true } })
  expect(node.trend).toHaveLength(2)
  expect((await scorecards(stores, { by: 'recipe' })).find((card) => card.key.recipeKey === 'new')?.regression?.suspected).toBe(true)
  expect((await scorecards(stores, { by: 'skill' })).find((card) => card.key.skill?.hash === 'new')?.regression?.suspected).toBe(true)
})
