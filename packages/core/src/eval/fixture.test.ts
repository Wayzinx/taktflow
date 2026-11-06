import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { initProject } from '../store/project.js'
import { createEngine } from '../engine/index.js'
import type { AgentProfile, ArtifactKind, DefectAttribution, EvalCase, HarnessAdapter, HarnessRequest, WorkflowDefinition } from '../types.js'
import { reportDefect, attributeDefect, confirmDefect, precheckDefect, getDefect } from '../defects/index.js'
import { listEvalCases, saveEvalCase, collectCases } from './cases.js'
import { scorecards } from './scorecards.js'
import { compareEval, getEvalRun, listEvalRuns, runEval, waitEvalRun } from './runner.js'
import { recipeOf } from '../engine/recipe.js'
import { createCommandRegistry } from '../commands/index.js'
import { evalCommandSpecs } from '../commands/eval-commands.js'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))) })
const person = { type: 'human' as const, id: 'tester' }
async function fixture(requirementId = 'REQ-001') {
  const root = await mkdtemp(join(tmpdir(), 'takt-eval-test-')); roots.push(root)
  const stores = await initProject(root)
  const requirement = await stores.workspaces.createRequirement({ id: requirementId, title: '交付功能' })
  const profiles: Record<string, AgentProfile> = Object.fromEntries(['pm', 'qa', 'case-author', 'dev', 'auditor', 'evaluator'].map((role) => [role, {
    role, title: role, description: '', instructions: role, harness: { harness: 'mock', model: role === 'evaluator' ? 'judge-model' : 'tested-model' }, skills: [], writeScope: ['**'],
  }]))
  let runId = '', badEvidence = false
  const requests: HarnessRequest[] = []
  const harness: HarnessAdapter = { id: 'mock', displayName: 'fixture', capabilities: { structuredOutput: true, usage: true }, available: async () => ({ ok: true }),
    async run(request) {
      requests.push(request)
      const role = request.env?.TAKT_ROLE
      const finish = (structured: unknown) => ({ ok: true, finalText: JSON.stringify(structured), structured, usage: { inputTokens: 10, outputTokens: 5 } })
      if (role === 'auditor') {
        expect(request.sessionId).toBeUndefined(); expect(request.tools?.writeScope).toEqual([])
        expect(request.prompt).toContain('AC-2')
        const attr: Partial<DefectAttribution> = { introducedAt: { origin: 'implementation', runId, nodeId: 'impl', evidence: ['实现未处理 AC-2'] },
          missedBy: [{ runId, nodeId: 'test-plan', reason: 'not_covered', evidence: ['测分仅覆盖 AC-1'] }], confidence: 0.9,
          suggestions: [{ target: { kind: 'completion', ref: 'test-plan' }, change: '逐项检查 AC 的覆盖' }] }
        return finish(attr)
      }
      if (role === 'evaluator') {
        expect(request.tools).toEqual({ writeScope: [], allowBash: false })
        const payload = JSON.parse(request.prompt.split('\n')[1]!) as { criteria: string[]; outputs: Array<{ content: string }> }
        const pass = payload.outputs.some((output) => output.content.includes('GOOD'))
        return finish({ checks: payload.criteria.map((criterion, index) => ({ id: `c${index + 1}`, criterion, pass, evidence: badEvidence ? '' : '检查冻结输出中的 AC-2 实现' })), score: pass ? 95 : 20, reason: pass ? '覆盖完整' : 'AC-2 缺失', rubric: { score: pass ? 95 : 20, reason: 'rubric' }, reference: { score: pass ? 90 : 20, reason: '参考答案' } })
      }
      const node = request.env?.TAKT_NODE
      let path: string, content: string
      if (node === 'prd') { path = 'spec/prd.md'; content = 'AC-1 正常路径\nAC-2 异常路径' }
      else if (node === 'test-plan') { path = 'design/tests.md'; content = 'AC-1 正常路径计划' }
      else if (node === 'cases') { path = 'cases/TC-1.json'; content = JSON.stringify({ id: 'TC-1', covers: ['AC-1'] }) }
      else { path = 'code/change.md'; content = request.model === 'improved-model' ? 'GOOD AC-1 AC-2' : 'BAD AC-1 AC-2 未实现' }
      const file = join(request.env!.TAKT_WORKSPACE!, path)
      await mkdir(dirname(file), { recursive: true }); await writeFile(file, content)
      return finish({ summary: content })
    },
  }
  const deps = { stores, profiles, harnesses: { mock: harness }, knowledge: [] }
  const definitions = [
    ['prd', 'pm', 'spec/prd.md', 'spec'], ['test-plan', 'qa', 'design/tests.md', 'test-plan'], ['cases', 'case-author', 'cases/TC-1.json', 'case'], ['impl', 'dev', 'code/change.md', 'code-change'],
  ] as const
  const workflow: WorkflowDefinition = { id: 'delivery', version: '1', title: '交付', stages: [], nodes: definitions.map(([id, role, path, kind], index) => ({
    id, role, kind: 'agent', title: id, prompt: `执行 ${id}`, needs: index ? [definitions[index - 1]![0]] : [],
    inputs: index ? [{ path: definitions[index - 1]![2] }] : [], outputs: [{ path, kind: kind as ArtifactKind }],
  })) }
  const run = await createEngine(deps).start({ workflow, requirementId: requirement.id })
  runId = run.runId
  expect(run.status).toBe('succeeded')
  return { root, stores, deps, run, requests, setBadEvidence: () => { badEvidence = true } }
}

it('完整交付 → AC-2 预检 → 独立归因 → 人确认 → 两条回归用例 → 成绩单 → A/B better', async () => {
  const { stores, deps, run, requests } = await fixture()
  const defect = await reportDefect(stores, 'REQ-001', { title: '异常路径缺失', description: 'AC-2 没有用例覆盖，代码未实现', severity: 'major', acs: ['AC-2'] }, person)
  expect(defect.id).toBe('D-1')
  const count = requests.length
  expect(await precheckDefect(stores, defect)).toMatchObject({ acCovered: false, cases: [], evidence: [] })
  expect(requests).toHaveLength(count)
  expect(await precheckDefect(stores, { ...defect, acs: ['AC-1'] })).toMatchObject({ acCovered: true, cases: ['TC-1'] })
  const attributed = await attributeDefect(deps, 'REQ-001', defect.id)
  expect(attributed.status).toBe('attributed')
  expect((await scorecards(stores, { by: 'node' })).find((card) => card.key.nodeId === 'test-plan')?.escapes).toBe(0)
  await expect(confirmDefect(stores, 'REQ-001', defect.id, {}, { type: 'agent', role: 'auditor', harness: 'mock' })).rejects.toThrow('由人确认')
  await confirmDefect(stores, 'REQ-001', defect.id, { note: '核对了 AC-2 与实际代码' }, person)
  const cases = await listEvalCases(stores)
  expect(cases).toHaveLength(2)
  expect(cases.every((value) => value.source.kind === 'defect')).toBe(true)
  const testCard = (await scorecards(stores, { by: 'node' })).find((card) => card.key.nodeId === 'test-plan')!
  expect(testCard).toMatchObject({ executions: 1, escapes: 0, detection: { caught: 0, missed: 1, rate: 0 } })
  expect((await scorecards(stores, { by: 'node' })).find((card) => card.key.nodeId === 'impl')?.escapes).toBe(1)
  expect((await getDefect(stores, 'REQ-001', defect.id)).attribution?.confirmed?.by).toEqual(person)
  expect((await stores.events.verify('defect-REQ-001')).ok).toBe(true)
  expect((await stores.workspaces.listArtifacts('REQ-001')).find((a) => a.path === 'defects/D-1.attribution.json')!.versions.at(-1)?.reason).toContain('AC-2')
  const implementation = cases.find((value) => value.source.nodeId === 'impl')!
  for (let i = 1; i <= 2; i++) await saveEvalCase(stores, { ...implementation, id: `manual-${i}`, source: { kind: 'manual' } })
  const started = await runEval(deps, { target: implementation.target, variants: [{ id: 'candidate', label: '改进模型', harness: { harness: 'mock', model: 'improved-model' } }] }, person)
  expect(started.status).toBe('running')
  const finished = await waitEvalRun(stores, started.id)
  expect(finished.status).toBe('done')
  expect(finished.results.map((row) => row.error)).toEqual(Array(6).fill(undefined))
  expect(finished.comparison).toMatchObject({ verdict: 'better', wins: 3, losses: 0, ties: 0, regressionsFailed: [], passRate: { baseline: 0, candidate: 1 } })
  expect((await getEvalRun(stores, started.id)).results).toHaveLength(6)
  expect((await listEvalRuns(stores))[0]?.results).toEqual([])
  expect((await stores.runs.list())).toHaveLength(1)
  expect((await stores.workspaces.readArtifact({ workspace: 'REQ-001', path: 'code/change.md' }))!.toString()).toContain('BAD')
  expect(recipeOf(await stores.events.read(run.runId), 'impl')).toMatchObject({ model: 'tested-model', kind: 'agent', role: 'dev' })
  expect(await collectCases(stores, { includeDefects: true })).toEqual({ added: [] })
})

it('回放独立模型与证据校验；路径越界拒绝；少于三例不宣称提升', async () => {
  const { stores, deps, setBadEvidence } = await fixture()
  const value: EvalCase = { id: 'case-1', target: { kind: 'node', workflowId: 'delivery', nodeId: 'impl' }, title: '回放', source: { kind: 'manual' },
    node: { id: 'impl', kind: 'agent', title: '实现', role: 'dev', needs: [], outputs: [{ path: 'code/change.md', kind: 'code-change' }] }, prompt: '实现 AC-2', inputs: [], grading: { checks: ['AC-2 已实现'], commands: ['test -f code/change.md'], rubric: { text: '覆盖率', threshold: 80 }, reference: { path: 'code/change.md', content: 'GOOD' } }, createdAt: new Date().toISOString() }
  await saveEvalCase(stores, value)
  await expect(saveEvalCase(stores, { ...value, id: '../escape' })).rejects.toThrow('非法')
  await expect(saveEvalCase(stores, { ...value, inputs: [{ path: '../escape', content: 'x' }] })).rejects.toThrow('非法')
  await expect(runEval(deps, { target: value.target, variants: [{ id: 'candidate', label: '模型', harness: { harness: 'mock', model: 'tested-model' } }], judge: { harness: 'mock', model: 'tested-model' } })).rejects.toThrow('不同')
  setBadEvidence()
  const started = await runEval(deps, { target: value.target, variants: [{ id: 'candidate', label: '模型', harness: { harness: 'mock', model: 'improved-model' } }] })
  const finished = await waitEvalRun(stores, started.id)
  expect(finished.comparison?.verdict).toBe('inconclusive')
  expect(finished.results.every((result) => !result.pass && result.error?.includes('缺少有效证据'))).toBe(true)
})

it('注册表暴露六个命令并拒绝 Agent 确认；并发录入不覆盖序号', async () => {
  const { stores, deps } = await fixture()
  stores.config.members = [{ id: 'tester', name: 'tester', role: 'owner' }]
  const registry = createCommandRegistry({ stores, audit: async () => {}, extensions: evalCommandSpecs(deps) })
  expect(registry.list().filter((item) => item.id.startsWith('eval.') || item.id.startsWith('defect.'))).toHaveLength(6)
  const request = { title: '缺陷', description: 'AC-2', severity: 'major' as const }
  const defects = await Promise.all([reportDefect(stores, 'REQ-001', request, person), reportDefect(stores, 'REQ-001', request, person)])
  expect(defects.map((item) => item.id).sort()).toEqual(['D-1', 'D-2'])
  const response = await registry.run('defect.confirm', { requirementId: 'REQ-001', defectId: 'D-1' }, { actor: { type: 'agent', role: 'auditor', harness: 'mock' }, reason: '测试权限' })
  expect(response).toMatchObject({ ok: false, message: expect.stringContaining('由人确认') })
})

it('A/B 以 pass 优先，分差 5 分为胜负，回归失败禁止 better', () => {
  const cases = [1, 2, 3].map((n) => ({ id: `c${n}`, source: { kind: 'defect' } })) as EvalCase[]
  const results = cases.flatMap((value) => [{ caseId: value.id, variant: 'a', pass: false, score: 99, usage: { inputTokens: 0, outputTokens: 0 }, durationMs: 1 }, { caseId: value.id, variant: 'b', pass: true, score: 1, usage: { inputTokens: 0, outputTokens: 0 }, durationMs: 1 }])
  expect(compareEval(cases, results, 'a', 'b')).toMatchObject({ wins: 3, verdict: 'better', cases: cases.map(({ id }) => ({ caseId: id, outcome: 'win' })) })
  results[1]!.pass = false; results[1]!.score = 0
  expect(compareEval(cases, results, 'a', 'b')).toMatchObject({ wins: 2, losses: 1, regressionsFailed: ['c1'], verdict: 'inconclusive' })
  results[3]!.pass = false; results[3]!.score = 95
  results[5]!.pass = false; results[5]!.score = 94
  expect(compareEval(cases, results, 'a', 'b')).toMatchObject({ wins: 0, losses: 2, ties: 1, verdict: 'worse', cases: [
    { caseId: 'c1', outcome: 'loss' }, { caseId: 'c2', outcome: 'tie' }, { caseId: 'c3', outcome: 'loss' },
  ] })
  expect(compareEval(cases.slice(0, 2), results, 'a', 'b').verdict).toBe('inconclusive')
  expect(compareEval(cases, results.slice(0, 4), 'a', 'b').cases).toHaveLength(2)
})

it('m3-fix 11：带点需求 ID 能确认并生成回归用例，冻结失败时不写 confirmed', async () => {
  const { stores, deps } = await fixture('REQ-1.2')
  const defect = await reportDefect(stores, 'REQ-1.2', { title: 'AC-2', description: '缺陷', severity: 'major', acs: ['AC-2'] }, person)
  await attributeDefect(deps, 'REQ-1.2', defect.id)
  const getWorkflow = stores.runs.getWorkflow.bind(stores.runs)
  stores.runs.getWorkflow = async () => undefined
  await expect(confirmDefect(stores, 'REQ-1.2', defect.id, {}, person)).rejects.toThrow('找不到节点定义')
  expect((await getDefect(stores, 'REQ-1.2', defect.id)).status).toBe('attributed')
  expect(await listEvalCases(stores)).toEqual([])
  stores.runs.getWorkflow = getWorkflow
  await confirmDefect(stores, 'REQ-1.2', defect.id, {}, person)
  expect((await getDefect(stores, 'REQ-1.2', defect.id)).status).toBe('confirmed')
  expect(await listEvalCases(stores)).toHaveLength(2)
})
