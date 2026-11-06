import type { Actor, EvalCase, EvalCaseResult, EvalComparison, EvalRun, EvalRunRequest, EvalTarget, EvalVariant, SnapshotNode } from '@taktflow/core'
import type { EvalOutputSnapshot } from './source'
import { WF } from './mock-eval-scorecards'

/** 评测用例与评测运行（docs/design/20 §4）：ER-0001 better；ER-0002 worse 且挂了回归用例。 */

const WEB: Actor = { type: 'human', id: 'web' }
const LIN: Actor = { type: 'human', id: 'lin' }
const node = (id: string, role: string, title: string): SnapshotNode => ({ id, kind: 'agent', title, role, needs: [] })

export const targetKey = (t: EvalTarget) => (t.kind === 'node' ? `node:${t.workflowId}/${t.nodeId}` : `skill:${t.name}`)
export const parseTarget = (s: string): EvalTarget | undefined => {
  const m = /^node:([^/]+)\/(.+)$/.exec(s)
  if (m) return { kind: 'node', workflowId: m[1]!, nodeId: m[2]! }
  const k = /^skill:(.+)$/.exec(s)
  return k ? { kind: 'skill', name: k[1]! } : undefined
}

const TD: EvalTarget = { kind: 'node', workflowId: WF, nodeId: 'test-design' }
const PW: EvalTarget = { kind: 'skill', name: 'playwright-e2e' }

function mkCase(id: string, target: EvalTarget, title: string, source: EvalCase['source'], extra: Partial<EvalCase['grading']> = {}, createdAt = '2026-11-02T08:00:00Z'): EvalCase {
  const n = target.kind === 'node' ? node(target.nodeId, target.nodeId === 'test-design' ? 'test-designer' : 'dev', title) : node('automate', 'automation', '用例转自动化')
  return {
    id, target, title, source, node: n,
    inputs: [{ path: 'spec/spec.md', content: '# spec（冻结快照）', kind: 'spec' }, { path: 'design/contracts.json', content: '{}', kind: 'contract' }],
    grading: { checks: ['每条 AC 至少有一条用例', '断言落到业务字段或终态'], rubric: { text: '用例覆盖边界值、断言有效', threshold: 75 }, reference: { path: 'cases/', content: '（最终通过版本）' }, ...extra },
    createdAt,
  }
}

export function seedCases(): EvalCase[] {
  return [
    mkCase('EC-td-001', TD, '问候语用例设计（REQ-001，评审打回 1 次）', { kind: 'history', runId: 'run-20261104-0001', nodeId: 'test-design' }),
    mkCase('EC-td-002', TD, '订单导出用例设计（REQ-002，金额精度被人改写）', { kind: 'history', runId: 'run-20261104-0002', nodeId: 'test-design' }),
    mkCase('EC-td-003', TD, '支付回调幂等用例（REQ-003）', { kind: 'history', runId: 'run-20261104-0003', nodeId: 'test-design' }),
    mkCase('EC-td-004', TD, '会员积分过期用例（REQ-004）', { kind: 'history', runId: 'run-20261104-0004', nodeId: 'test-design' }),
    mkCase('EC-td-005', TD, '手写：分页边界（0 / 1 / 上限 / 上限+1）', { kind: 'manual' }),
    mkCase('EC-pw-001', PW, '技能用例：只用 data-testid 选择器', { kind: 'skill' }, { commands: ['npx playwright test --list'] }),
    mkCase('EC-pw-002', PW, '技能用例：失败时写截图与 dom.html', { kind: 'skill' }),
    mkCase('EC-pw-003', PW, '技能用例：异步列表等待到终态', { kind: 'skill' }),
    mkCase('EC-pw-004', PW, '导出按钮可见性断言（REQ-002 历史）', { kind: 'history', runId: 'run-20261104-0002', nodeId: 'automate' }),
    mkCase('EC-pw-005', PW, '回归：隐藏按钮不得被 force 点击绕过', { kind: 'defect', defectId: 'D-7' }, { mustNotIntroduce: ['对 hidden 元素使用 { force: true } 点击'] }, '2026-10-28T03:00:00Z'),
  ]
}

const BASE = (label: string): EvalVariant => ({ id: 'baseline', label })
const usage = (i: number, o: number) => ({ inputTokens: i, outputTokens: o, costUsd: (i * 3 + o * 15) / 1_000_000 })

function result(runId: string, caseId: string, variant: string, pass: boolean, score: number, reason: string, i = 0): EvalCaseResult {
  return {
    caseId, variant, pass, score,
    checks: [{ id: 'c1', criterion: '每条 AC 至少有一条用例', pass: true, evidence: 'cases/*.json 的 covers' }, { id: 'c2', criterion: '断言落到业务字段或终态', pass, evidence: pass ? '断言 result === expected' : '只断言了状态码' }],
    rubric: { score, reason },
    reference: { score: Math.max(0, score - 6), reason: pass ? '与参考版本覆盖一致，额外补了边界值' : '缺少参考版本中的边界用例' },
    usage: usage(18_000 + i * 900, 3_200 + i * 210),
    durationMs: 52_000 + i * 4_100,
    outputDir: `.takt/evals/runs/${runId}/${caseId}/${variant}/`,
  }
}

/** 与 core 的 compare 同口径：pass 不同按 pass 判；相同时分差 ≥ 5 算胜负。 */
export function compare(run: Pick<EvalRun, 'results' | 'variants' | 'caseIds'>, cases: EvalCase[]): EvalComparison | undefined {
  const [b, c] = run.variants
  if (!b || !c) return undefined
  let wins = 0, losses = 0, ties = 0
  const regressionsFailed: string[] = []
  const passRate: Record<string, number> = {}
  const meanScore: Record<string, number> = {}
  for (const v of run.variants) {
    const rs = run.results.filter((r) => r.variant === v.id)
    passRate[v.id] = rs.length ? rs.filter((r) => r.pass).length / rs.length : 0
    meanScore[v.id] = rs.length ? rs.reduce((a, r) => a + (r.score ?? 0), 0) / rs.length : 0
  }
  for (const id of run.caseIds) {
    const x = run.results.find((r) => r.caseId === id && r.variant === b.id)
    const y = run.results.find((r) => r.caseId === id && r.variant === c.id)
    if (!x || !y) continue
    const d = x.pass !== y.pass ? (y.pass ? 1 : -1) : Math.abs((y.score ?? 0) - (x.score ?? 0)) >= 5 ? Math.sign((y.score ?? 0) - (x.score ?? 0)) : 0
    if (d > 0) wins++
    else if (d < 0) losses++
    else ties++
    if (!y.pass && cases.find((k) => k.id === id)?.source.kind === 'defect') regressionsFailed.push(id)
  }
  const verdict: EvalComparison['verdict'] = run.caseIds.length < 3 ? 'inconclusive' : losses > wins ? 'worse' : wins > losses && regressionsFailed.length === 0 ? 'better' : wins === losses ? 'same' : 'inconclusive'
  return { baseline: b.id, candidate: c.id, wins, losses, ties, passRate, meanScore, regressionsFailed, verdict }
}

export function seedRuns(cases: EvalCase[]): EvalRun[] {
  const r1 = 'ER-0001'
  const v1: EvalVariant[] = [BASE('当前配方 · d18b5f3a'), { id: 'boundary-list', label: '测分 prompt v8：补边界值清单', promptFile: 'evals/variants/test-design-v8.md' }]
  const td = ['EC-td-001', 'EC-td-002', 'EC-td-003', 'EC-td-004', 'EC-td-005']
  const s1: Array<[boolean, number, boolean, number, string, string]> = [
    [true, 78, true, 86, '覆盖 AC-1/AC-2，未覆盖首尾空格', '补了首尾空格与全角空格用例'],
    [false, 64, true, 81, '金额只断言非空，未断言两位小数', '断言 12.50 与舍入规则'],
    [true, 82, true, 84, '幂等键用例齐全', '同上，另补重复回调间隔'],
    [true, 80, true, 79, '积分过期边界正确', '与基线一致'],
    [false, 58, true, 77, '只测了第 1 页', '覆盖 0 / 1 / 上限 / 上限+1'],
  ]
  const res1 = td.flatMap((id, i) => [result(r1, id, 'baseline', s1[i]![0], s1[i]![1], s1[i]![4], i), result(r1, id, 'boundary-list', s1[i]![2], s1[i]![3], s1[i]![5], i + 1)])

  const r2 = 'ER-0002'
  const v2: EvalVariant[] = [BASE('playwright-e2e v3 · 9c1e33f0'), { id: 'pw-v4', label: 'playwright-e2e v4：networkidle 等待 + force 点击', skillsDir: 'evals/variants/skills-pw-v4' }]
  const pw = ['EC-pw-001', 'EC-pw-002', 'EC-pw-003', 'EC-pw-004', 'EC-pw-005']
  const s2: Array<[boolean, number, boolean, number, string, string]> = [
    [true, 88, true, 87, '全部使用 data-testid', '全部使用 data-testid'],
    [true, 84, true, 85, '截图与 dom.html 齐全', '截图与 dom.html 齐全'],
    [true, 81, false, 62, '等待到列表终态再断言', 'networkidle 早于列表渲染，断言偶发取到空列表'],
    [true, 79, false, 55, '对隐藏按钮断言 toBeHidden', '用 force 点击绕过了隐藏按钮，断言未生效'],
    [true, 90, false, 40, '未使用 force 点击', '违反 mustNotIntroduce：对 hidden 元素使用 { force: true }'],
  ]
  const res2 = pw.flatMap((id, i) => [result(r2, id, 'baseline', s2[i]![0], s2[i]![1], s2[i]![4], i), result(r2, id, 'pw-v4', s2[i]![2], s2[i]![3], s2[i]![5], i + 2)])

  const runs: EvalRun[] = [
    { id: r2, target: PW, variants: v2, caseIds: pw, status: 'done', startedAt: '2026-11-05T06:12:00Z', endedAt: '2026-11-05T06:31:40Z', by: LIN, results: res2 },
    { id: r1, target: TD, variants: v1, caseIds: td, status: 'done', startedAt: '2026-11-04T09:40:00Z', endedAt: '2026-11-04T10:02:15Z', by: WEB, results: res1 },
  ]
  for (const r of runs) r.comparison = compare(r, cases)
  return runs
}

/** 新建评测：后台跑，2.4 秒后出结果（确定性的伪分数）。 */
export function startRun(runs: EvalRun[], cases: EvalCase[], req: EvalRunRequest): EvalRun | string {
  if (req.variants.length === 0) return '至少需要一个候选变体'
  const t = targetKey(req.target)
  const pool = cases.filter((c) => targetKey(c.target) === t)
  const caseIds = req.caseIds?.length ? req.caseIds : pool.map((c) => c.id)
  if (caseIds.length === 0) return `目标 ${t} 没有评测用例，先收集用例`
  if (req.judge?.model && req.judge.model === 'gpt-5-codex' && req.target.kind === 'node' && req.target.nodeId === 'automate') return 'judge 模型不能与被测模型相同'
  const variants = req.variants[0]?.id === 'baseline' ? req.variants : [BASE('当前配方'), ...req.variants]
  const id = `ER-${String(runs.length + 1).padStart(4, '0')}`
  const run: EvalRun = { id, target: req.target, variants, caseIds, status: 'running', startedAt: new Date().toISOString(), by: WEB, results: [] }
  runs.unshift(run)
  setTimeout(() => {
    run.results = caseIds.flatMap((cid, i) =>
      variants.map((v, j) => {
        const seed = (cid.charCodeAt(cid.length - 1) * 7 + j * 13 + i * 5) % 30
        const score = 62 + seed + (j > 0 ? 4 : 0)
        return result(id, cid, v.id, score >= 72, Math.min(98, score), j > 0 ? '候选：覆盖更完整' : '基线', i + j)
      }),
    )
    run.status = 'done'
    run.endedAt = new Date().toISOString()
    run.comparison = compare(run, cases)
  }, 2400)
  return run
}

export function outputOf(run: EvalRun, caseId: string, variant: string): EvalOutputSnapshot {
  const r = run.results.find((x) => x.caseId === caseId && x.variant === variant)
  const skill = run.target.kind === 'skill'
  const files = skill
    ? [{ path: `tests/${caseId}.spec.ts`, content: r?.pass ? `test('${caseId}', async ({ page }) => {\n  await page.goto('/orders')\n  await expect(page.getByTestId('order-list')).toHaveCount(20)\n  await expect(page.getByTestId('order-export-btn')).toBeHidden()\n})` : `test('${caseId}', async ({ page }) => {\n  await page.goto('/orders', { waitUntil: 'networkidle' })\n  await page.getByTestId('order-export-btn').click({ force: true })\n})` }]
    : [{ path: `cases/${caseId}.json`, content: JSON.stringify({ id: caseId.replace('EC-td', 'TC'), covers: ['AC-1', 'AC-2'], steps: ['调用 greet(name)'], assert: r?.pass ? 'result === expected' : 'result !== undefined' }, null, 2) }, { path: 'test-plan/plan.md', content: `# 测试计划（${variant}）\n\n- 范围：AC-1、AC-2\n- 边界：${r?.pass ? '空串、纯空格、首尾空格、全角空格' : '空串'}` }]
  return { runId: run.id, caseId, variant, outputDir: r?.outputDir, files }
}
