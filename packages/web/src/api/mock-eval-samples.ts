import type { Actor, EvalCase, EvalCaseResult, EvalComparison, EvalGate, EvalReport, EvalRun, EvalTarget, EvalVariant } from '@taktflow/core'
import { WF } from './mock-eval-scorecards'

/**
 * 检查点样本与回放报告（docs/design/21 §5–6）：
 * - 样本 S-001…S-007 都绑定 review-design 评审者检查点当时的快照；S-007 已退役；
 * - ER-0003：沙箱隔离，6 个样本 × 3 次，按门槛"达标"；
 * - ER-0004：隔离校验不通过，拒绝启动；
 * - ER-0005：mock harness 模拟隔离，2 个样本 × 2 次，只作探索（含证据不足与误报）。
 */

const LIN: Actor = { type: 'human', id: 'lin' }
const WEB: Actor = { type: 'human', id: 'web' }
export const RD: EvalTarget = { kind: 'node', workflowId: WF, nodeId: 'review-design' }
export const GATE: EvalGate = { minSamples: 5, minRepeats: 3, maxPassRateDrop: 0.05, maxFalsePositiveIncrease: 0, regressionsMustPass: true }

const cp = (runId: string, subject = 'reviewer') => `${runId}:review-design:1:1.1:${subject}`

function sample(id: string, kind: 'must_catch' | 'clean', runId: string, title: string, opts: { defectId?: string; expectIssue?: string; subject?: string; createdAt: string; retiredAt?: string }): EvalCase {
  const checkpointId = cp(runId, opts.subject)
  return {
    id, target: RD, title,
    source: { kind: kind === 'must_catch' ? 'defect' : 'manual', runId, nodeId: 'review-design', defectId: opts.defectId },
    node: { id: 'review-design', kind: 'agent', title: opts.subject ?? 'reviewer', role: opts.subject ?? 'reviewer', needs: [] },
    inputs: [{ path: 'design/design.md', content: '# 系分（检查点快照）' }, { path: 'spec/spec.md', content: '# spec（检查点快照）' }],
    grading: kind === 'must_catch' ? { mustFind: [opts.expectIssue ?? title] } : {},
    createdAt: opts.createdAt,
    sample: { kind, checkpointId, snapshot: `snapshots/${runId}/review-design-1-1.1-${opts.subject ?? 'reviewer'}`, expectIssue: kind === 'must_catch' ? opts.expectIssue ?? title : undefined, retiredAt: opts.retiredAt },
  }
}

export function seedSamples(): EvalCase[] {
  return [
    sample('S-001', 'must_catch', 'run-20261104-0002', '收货地址含逗号时 CSV 列错位', { defectId: 'D-1', expectIssue: '系分没有约定 CSV 字段的引号 / 逗号转义', createdAt: '2026-11-05T08:40:00Z' }),
    sample('S-002', 'must_catch', 'run-20261104-0004', '优惠券过期提醒按 UTC 计算，晚 8 小时', { defectId: 'D-1', expectIssue: '提醒时间没有写明时区口径', createdAt: '2026-11-05T09:02:00Z' }),
    sample('S-003', 'must_catch', 'run-20261104-0003', '图形验证码失败次数没有上限', { defectId: 'D-2', expectIssue: '没有限制连续失败次数与冷却时间', createdAt: '2026-11-05T09:10:00Z' }),
    sample('S-004', 'clean', 'run-20261104-0001', '无缺陷评审：问候语支持空名字', { createdAt: '2026-11-05T09:30:00Z' }),
    sample('S-005', 'clean', 'run-20261104-0005', '无缺陷评审：搜索结果关键词高亮', { createdAt: '2026-11-05T09:31:00Z' }),
    sample('S-006', 'clean', 'run-20261104-0003', '无缺陷评审：登录页验证码（安全）', { subject: 'security', createdAt: '2026-11-05T09:33:00Z' }),
    sample('S-007', 'must_catch', 'run-20261103-0007', '只读账号仍能看到导出按钮', { defectId: 'D-4', expectIssue: '权限矩阵没有覆盖只读角色', createdAt: '2026-11-03T10:00:00Z', retiredAt: '2026-11-05T09:40:00Z' }),
  ]
}

/** Wilson 95% 区间：与 core/eval/statistics.ts 同一公式（分母不含证据不足）。 */
export function wilson95(pass: number, fail: number): EvalReport['passRate'][string] {
  const n = pass + fail
  if (!n) return { rate: 0, low: 0, high: 1, n: 0 }
  const rate = pass / n, z = 1.959963984540054, z2 = z * z
  const center = (rate + z2 / (2 * n)) / (1 + z2 / n)
  const radius = (z * Math.sqrt((rate * (1 - rate)) / n + z2 / (4 * n * n))) / (1 + z2 / n)
  return { rate, low: Math.max(0, center - radius), high: Math.min(1, center + radius), n }
}

type Run = EvalReport['samples'][number]['variants'][string]['runs'][number]
const P: Run = { outcome: 'pass' }
const F = (reason: string, falsePositive = false): Run => ({ outcome: 'fail', reason, falsePositive: falsePositive || undefined })
const I = (reason: string): Run => ({ outcome: 'insufficient', reason })

/** 与 buildEvalReport 同口径：逐次 → 计数 → 区间、误报、证据不足 → 探索性 → 门槛结论。 */
export function buildReport(cases: EvalCase[], variants: EvalVariant[], repeats: number, trials: Record<string, Record<string, Run[]>>, isolation: EvalRun['isolation'], gate = GATE): EvalReport {
  const report: EvalReport = { samples: [], passRate: {}, falsePositives: {}, insufficient: {}, exploratory: true, judge: { recipeKey: 'judge-7c2e91d0', blind: true } }
  for (const c of cases) {
    const s: EvalReport['samples'][number] = { caseId: c.id, kind: c.sample?.kind ?? 'node', variants: {} }
    for (const v of variants) {
      const runs = Array.from({ length: repeats }, (_, i) => trials[c.id]?.[v.id]?.[i] ?? I('逐次结果缺失，不能作为通过'))
      s.variants[v.id] = { runs, pass: runs.filter((r) => r.outcome === 'pass').length, fail: runs.filter((r) => r.outcome === 'fail').length, insufficient: runs.filter((r) => r.outcome === 'insufficient').length, falsePositives: runs.filter((r) => r.falsePositive).length }
    }
    report.samples.push(s)
  }
  for (const v of variants) {
    const rows = report.samples.map((s) => s.variants[v.id]!)
    report.passRate[v.id] = wilson95(rows.reduce((n, r) => n + r.pass, 0), rows.reduce((n, r) => n + r.fail, 0))
    report.falsePositives[v.id] = rows.reduce((n, r) => n + r.falsePositives, 0)
    report.insufficient[v.id] = rows.reduce((n, r) => n + r.insufficient, 0)
  }
  report.exploratory = cases.length < gate.minSamples || repeats < gate.minRepeats || isolation?.mode === 'simulated'
  const reasons: string[] = []
  if (cases.length < gate.minSamples) reasons.push(`样本数 ${cases.length} 低于门槛 ${gate.minSamples}`)
  if (repeats < gate.minRepeats) reasons.push(`重复次数 ${repeats} 低于门槛 ${gate.minRepeats}`)
  if (isolation?.mode === 'simulated') reasons.push('mock 模拟隔离，只用于测试和演示，不作为发布依据')
  if (isolation?.ok === false) reasons.push('隔离校验未通过，评测未启动')
  report.gate = { verdict: reasons.length ? 'not_applicable' : 'pass', reasons, config: { ...gate } }
  if (reasons.length) return report
  const [b, ...cands] = variants
  if (Object.values(report.insufficient).some((n) => n > 0)) reasons.push('存在证据不足的重复结果，不能通过发布门槛')
  for (const k of cands) {
    if (report.passRate[b!.id]!.rate - report.passRate[k.id]!.rate > gate.maxPassRateDrop + 1e-12) reasons.push(`${k.id} 通过率下降超过门槛`)
    if (report.falsePositives[k.id]! - report.falsePositives[b!.id]! > gate.maxFalsePositiveIncrease) reasons.push(`${k.id} 误报增加超过门槛`)
    if (gate.regressionsMustPass && report.samples.some((s) => s.kind === 'must_catch' && s.variants[k.id]!.pass !== repeats)) reasons.push(`${k.id} 回归样本未全部通过`)
  }
  if (reasons.length) report.gate.verdict = 'fail'
  return report
}

/** 旧 comparison 每例一个结果：汇总全部重复（全过才算过，分数 = 通过次数占比）。 */
export function aggregate(report: EvalReport, repeats: number): EvalCaseResult[] {
  return report.samples.flatMap((s) =>
    Object.entries(s.variants).map(([variant, r]) => ({ caseId: s.caseId, variant, pass: r.pass === repeats, score: Math.round((r.pass / repeats) * 100), usage: { inputTokens: 0, outputTokens: 0 }, durationMs: 0 })),
  )
}

export function seedReportRuns(samples: EvalCase[], compare: (r: Pick<EvalRun, 'results' | 'variants' | 'caseIds'>) => EvalComparison | undefined): EvalRun[] {
  const pick = (ids: string[]) => ids.map((id) => samples.find((c) => c.id === id)!)
  const base = (label: string): EvalVariant => ({ id: 'baseline', label })

  // ER-0003：达标
  const v3: EvalVariant[] = [base('当前配方 · 5e0c2a7b'), { id: 'reviewer-v5', label: '评审者档案 v5：系分评审补输出格式与转义检查', profileFile: 'evals/variants/reviewer.v5.md' }]
  const c3 = pick(['S-001', 'S-002', 'S-003', 'S-004', 'S-005', 'S-006'])
  const iso3: EvalRun['isolation'] = { ok: true, mode: 'sandbox', reasons: [] }
  const t3: Record<string, Record<string, Run[]>> = {
    'S-001': { baseline: [F('只提了金额精度，没有提转义'), F('没有提出转义问题'), P], 'reviewer-v5': [P, P, P] },
    'S-002': { baseline: [F('提醒时间只写"前 24 小时"，没追问时区'), F('没有提出时区口径'), F('没有提出时区口径')], 'reviewer-v5': [P, P, P] },
    'S-003': { baseline: [P, P, P], 'reviewer-v5': [P, P, P] },
    'S-004': { baseline: [P, P, P], 'reviewer-v5': [P, P, P] },
    'S-005': { baseline: [P, F('提出 major：高亮没有转义 HTML（原系分已写明用 textContent）', true), P], 'reviewer-v5': [P, P, P] },
    'S-006': { baseline: [P, P, P], 'reviewer-v5': [P, P, P] },
  }
  const r3 = buildReport(c3, v3, 3, t3, iso3)
  const run3: EvalRun = {
    id: 'ER-0003', target: RD, variants: v3, caseIds: c3.map((c) => c.id), status: 'done', isolation: iso3, repeats: 3, report: r3,
    candidates: { baseline: 'cand-5e0c2a7b91f4', 'reviewer-v5': 'cand-b71c08e3d2a6' }, judgeCandidate: 'cand-j-7c2e91d04b38', frozenCases: c3,
    startedAt: '2026-11-05T11:20:00Z', endedAt: '2026-11-05T11:46:30Z', by: LIN, results: aggregate(r3, 3),
  }

  // ER-0004：拒绝启动
  const v4: EvalVariant[] = [base('当前配方 · 5e0c2a7b'), { id: 'reviewer-codex', label: '评审者换 codex：gpt-5-codex', harness: { harness: 'codex', model: 'gpt-5-codex' } }]
  const c4 = pick(['S-001', 'S-002', 'S-003', 'S-004', 'S-005'])
  const iso4: EvalRun['isolation'] = {
    ok: false,
    reasons: ['harness codex 没有声明 readOnly 能力，且本机没有 bwrap / docker：不能保证回放不改到真实空间', '样本 S-002 的漏检归因已被改判（不在职责内）；请重新确认后启动评测'],
  }
  const run4: EvalRun = {
    id: 'ER-0004', target: RD, variants: v4, caseIds: c4.map((c) => c.id), status: 'refused', isolation: iso4, repeats: 3, report: buildReport(c4, v4, 3, {}, iso4),
    frozenCases: c4, startedAt: '2026-11-05T12:05:00Z', endedAt: '2026-11-05T12:05:01Z', by: WEB, results: [],
  }

  // ER-0005：探索性
  const v5: EvalVariant[] = [base('当前配方 · 5e0c2a7b'), { id: 'reviewer-haiku', label: '评审者换 haiku：省成本', harness: { harness: 'claude-code', model: 'haiku' } }]
  const c5 = pick(['S-001', 'S-004'])
  const iso5: EvalRun['isolation'] = { ok: true, mode: 'simulated', reasons: ['mock harness：模拟隔离，只用于测试和演示'] }
  const t5: Record<string, Record<string, Run[]>> = {
    'S-001': { baseline: [P, P], 'reviewer-haiku': [F('只提了金额精度'), I('评委无法判定：候选输出被截断')] },
    'S-004': { baseline: [P, P], 'reviewer-haiku': [P, F('提出 major：导出接口缺少鉴权（原评审对象不含接口）', true)] },
  }
  const r5 = buildReport(c5, v5, 2, t5, iso5)
  const run5: EvalRun = {
    id: 'ER-0005', target: RD, variants: v5, caseIds: c5.map((c) => c.id), status: 'done', isolation: iso5, repeats: 2, report: r5,
    candidates: { baseline: 'cand-5e0c2a7b91f4', 'reviewer-haiku': 'cand-0d4f6e19a7c3' }, judgeCandidate: 'cand-j-7c2e91d04b38', frozenCases: c5,
    startedAt: '2026-11-05T12:30:00Z', endedAt: '2026-11-05T12:33:10Z', by: WEB, results: aggregate(r5, 2),
  }

  const runs = [run5, run4, run3]
  for (const r of runs) {
    if (r.status !== 'done') continue
    r.comparison = compare(r)
    if (r.comparison && (r.report!.exploratory || r.report!.gate?.verdict !== 'pass')) r.comparison.verdict = 'inconclusive'
  }
  return runs
}

/** 新建的回放评测：确定性的逐次结果（候选略好；第一个 clean 样本基线有一次误报）。 */
export function replayTrials(cases: EvalCase[], variants: EvalVariant[], repeats: number): Record<string, Record<string, Run[]>> {
  const out: Record<string, Record<string, Run[]>> = {}
  cases.forEach((c, i) => {
    out[c.id] = {}
    variants.forEach((v, j) => {
      out[c.id]![v.id] = Array.from({ length: repeats }, (_, k) => {
        const seed = (c.id.charCodeAt(c.id.length - 1) * 7 + i * 5 + k * 3 + j * 11) % 10
        if (c.sample?.kind === 'clean') return j === 0 && i % 3 === 0 && k === 1 ? F('提出 major：原评审对象之外的问题', true) : P
        return seed < (j > 0 ? 8 : 5) ? P : F(`没有提出「${c.sample?.expectIssue ?? c.title}」`)
      })
    })
  })
  return out
}
