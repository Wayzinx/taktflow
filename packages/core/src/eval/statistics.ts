import type { EvalCase, EvalGate, EvalReport, EvalRun, EvalVariant } from '../types.js'
import { sha256 } from '../util/hash.js'

export type ReplayVerdict = EvalReport['samples'][number]['variants'][string]['runs'][number]
export interface ReplayTrial { caseId: string; variant: string; repeat: number; verdict: ReplayVerdict }

export function wilson95(pass: number, fail: number): EvalReport['passRate'][string] {
  if (![pass, fail].every(n => Number.isSafeInteger(n) && n >= 0)) throw new Error('统计计数必须是非负整数；请核对逐次结果')
  const n = pass + fail
  if (!n) return { rate: 0, low: 0, high: 1, n: 0 }
  const rate = pass / n, z = 1.959963984540054, z2 = z * z
  const center = (rate + z2 / (2 * n)) / (1 + z2 / n)
  const radius = z * Math.sqrt(rate * (1 - rate) / n + z2 / (4 * n * n)) / (1 + z2 / n)
  return { rate, low: Math.max(0, center - radius), high: Math.min(1, center + radius), n }
}

export function blindOrder<T extends { caseId: string; variant: string; repeat: number }>(rows: T[], seed: string): T[] {
  const key = (row: T) => sha256(JSON.stringify([seed, row.caseId, row.variant, row.repeat]))
  return [...rows].sort((a, b) => key(a).localeCompare(key(b)))
}

export function validateEvalGate(gate?: EvalGate): void {
  if (!gate) return
  if (!Number.isSafeInteger(gate.minSamples) || gate.minSamples < 1 || !Number.isSafeInteger(gate.minRepeats) || gate.minRepeats < 1
    || !Number.isFinite(gate.maxPassRateDrop) || gate.maxPassRateDrop < 0 || gate.maxPassRateDrop > 1
    || !Number.isSafeInteger(gate.maxFalsePositiveIncrease) || gate.maxFalsePositiveIncrease < 0 || typeof gate.regressionsMustPass !== 'boolean') {
    throw new Error('发布门槛无效；请预先配置正整数样本数 / 重复数、0–1 通过率降幅与非负误报增量')
  }
}

export function buildEvalReport(cases: EvalCase[], variants: EvalVariant[], repeats: number, trials: ReplayTrial[], options: {
  gate?: EvalGate; isolation?: EvalRun['isolation']; judgeRecipeKey?: string
} = {}): EvalReport {
  validateEvalGate(options.gate)
  const report: EvalReport = { samples: [], passRate: {}, falsePositives: {}, insufficient: {}, exploratory: true,
    judge: { recipeKey: options.judgeRecipeKey, blind: true } }
  for (const value of cases) {
    const sample: EvalReport['samples'][number] = { caseId: value.id, kind: value.sample?.kind ?? 'node', variants: {} }
    for (const variant of variants) {
      const runs: ReplayVerdict[] = []
      for (let repeat = 0; repeat < repeats; repeat++) {
        const matches = trials.filter(row => row.caseId === value.id && row.variant === variant.id && row.repeat === repeat)
        runs.push(matches.length === 1 ? matches[0]!.verdict : { outcome: 'insufficient', reason: '逐次结果缺失或重复，不能作为通过' })
      }
      sample.variants[variant.id] = { runs, pass: runs.filter(r => r.outcome === 'pass').length, fail: runs.filter(r => r.outcome === 'fail').length,
        insufficient: runs.filter(r => r.outcome === 'insufficient').length, falsePositives: runs.filter(r => r.falsePositive).length }
    }
    report.samples.push(sample)
  }
  for (const variant of variants) {
    const rows = report.samples.map(s => s.variants[variant.id]!)
    report.passRate[variant.id] = wilson95(rows.reduce((n, r) => n + r.pass, 0), rows.reduce((n, r) => n + r.fail, 0))
    report.falsePositives[variant.id] = rows.reduce((n, r) => n + r.falsePositives, 0)
    report.insufficient[variant.id] = rows.reduce((n, r) => n + r.insufficient, 0)
  }
  const gate = options.gate
  report.exploratory = !gate || cases.length < gate.minSamples || repeats < gate.minRepeats || options.isolation?.mode === 'simulated'
  if (!gate) return report
  const reasons: string[] = []
  if (cases.length < gate.minSamples) reasons.push(`样本数 ${cases.length} 低于门槛 ${gate.minSamples}`)
  if (repeats < gate.minRepeats) reasons.push(`重复次数 ${repeats} 低于门槛 ${gate.minRepeats}`)
  if (options.isolation?.mode === 'simulated') reasons.push('mock 模拟隔离，只用于测试和演示，不作为发布依据')
  if (options.isolation?.ok === false) reasons.push('隔离校验未通过，评测未启动')
  if (variants.length < 2) reasons.push('缺少候选与基线对照')
  report.gate = { verdict: reasons.length ? 'not_applicable' : 'pass', reasons, config: structuredClone(gate) }
  if (reasons.length) return report
  const baseline = variants.find(v => v.id === 'baseline') ?? variants[0]!
  if (Object.values(report.insufficient).some(n => n > 0)) reasons.push('存在证据不足的重复结果，不能通过发布门槛')
  for (const candidate of variants.filter(v => v.id !== baseline.id)) {
    if (report.passRate[baseline.id]!.rate - report.passRate[candidate.id]!.rate > gate.maxPassRateDrop + 1e-12) reasons.push(`${candidate.id} 通过率下降超过门槛`)
    if (report.falsePositives[candidate.id]! - report.falsePositives[baseline.id]! > gate.maxFalsePositiveIncrease) reasons.push(`${candidate.id} 误报增加超过门槛`)
    if (gate.regressionsMustPass && report.samples.some(s => (s.kind === 'must_catch' || cases.find(c => c.id === s.caseId)?.source.kind === 'defect')
      && s.variants[candidate.id]!.pass !== repeats)) reasons.push(`${candidate.id} 回归样本未全部通过`)
  }
  if (reasons.length) report.gate.verdict = 'fail'
  return report
}
