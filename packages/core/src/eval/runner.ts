import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type { EngineDeps, ProjectStores } from '../interfaces.js'
import type { EvalRunRequest } from '../api.js'
import type { Actor, EvalCase, EvalCaseResult, EvalComparison, EvalRun, EvalVariant, Invocation } from '../types.js'
import { harnessSelectors, resolveHarnessSelector, selectHarness } from '../engine/selection.js'
import { listEvalCases, validateEvalCase } from './cases.js'
import { evalId, jsonFiles, targetName } from './storage.js'
import { resolveVariantPaths } from './variant-paths.js'
import { appendEvalObject, evalRevision, evalView, qualityStore } from './quality-access.js'
import { confirmedMiss, replaySource, type ReplaySource } from './samples.js'
import { freezeEvalCandidate } from './candidates.js'
import { preflightIsolation } from './isolation.js'
import { blindOrder, buildEvalReport, validateEvalGate } from './statistics.js'
import { candidateProfile, executeReplay, judgeRecipe, judgeReplay, replaySelector, type ReplayOutput, type ReplayPlan } from './replay.js'

const jobs = new Map<string, Promise<void>>()
const jobKey = (stores: ProjectStores, id: string) => `${stores.projectDir}:${id}`
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error)

export function compareEval(cases: EvalCase[], results: EvalCaseResult[], baseline: string, candidate: string): EvalComparison {
  const comparison: EvalComparison = { baseline, candidate, cases: [], wins: 0, losses: 0, ties: 0, passRate: {}, meanScore: {}, regressionsFailed: [], verdict: 'inconclusive' }
  for (const variant of [baseline, candidate]) {
    const rows = cases.map((value) => results.find((result) => result.caseId === value.id && result.variant === variant))
    comparison.passRate[variant] = rows.length ? rows.filter((row) => row?.pass).length / rows.length : 0
    comparison.meanScore[variant] = rows.length ? rows.reduce((sum, row) => sum + (row?.score ?? 0), 0) / rows.length : 0
  }
  for (const value of cases) {
    const a = results.find((row) => row.caseId === value.id && row.variant === baseline)
    const b = results.find((row) => row.caseId === value.id && row.variant === candidate)
    if (value.source.kind === 'defect' && !b?.pass) comparison.regressionsFailed.push(value.id)
    if (!a || !b) continue
    const difference = Number(b.pass) - Number(a.pass) || (Math.abs((b.score ?? 0) - (a.score ?? 0)) >= 5 ? (b.score ?? 0) - (a.score ?? 0) : 0)
    comparison.cases!.push({ caseId: value.id, outcome: difference > 0 ? 'win' : difference < 0 ? 'loss' : 'tie' })
    if (difference > 0) comparison.wins++
    else if (difference < 0) comparison.losses++
    else comparison.ties++
  }
  if (cases.length >= 3 && comparison.wins + comparison.losses + comparison.ties === cases.length) {
    comparison.verdict = comparison.losses > comparison.wins ? 'worse'
      : comparison.wins > comparison.losses && !comparison.regressionsFailed.length ? 'better'
        : comparison.wins === comparison.losses ? 'same' : 'inconclusive'
  }
  return comparison
}


async function readRuns(stores: ProjectStores): Promise<EvalRun[]> {
  const current = await evalView<EvalRun>(stores, 'evaluations')
  const known = new Set(current.map(run => run.id))
  for (const legacy of await jsonFiles<EvalRun>(join(stores.taktDir, 'evals', 'runs'))) {
    if (known.has(legacy.id)) continue
    evalId(legacy.id)
    await appendEvalObject(stores, 'eval.started', legacy, { reason: '首次读取导入 M3 评测运行；不补造隔离与重复统计证据' })
    known.add(legacy.id)
  }
  return evalView<EvalRun>(stores, 'evaluations')
}
export async function getEvalRun(stores: ProjectStores, id: string): Promise<EvalRun> {
  evalId(id)
  const value = (await readRuns(stores)).find(run => run.id === id)
  if (!value) throw new Error(`评测运行不存在：${id}；请重新读取运行列表`)
  return value
}
export async function listEvalRuns(stores: ProjectStores): Promise<EvalRun[]> {
  return (await readRuns(stores)).sort((a, b) => b.startedAt.localeCompare(a.startedAt)).map(run => ({ ...run, results: [] }))
}
export async function getEvalInvocations(stores: ProjectStores, id: string): Promise<Invocation[]> {
  const run = await getEvalRun(stores, id)
  return run.replayEvidence?.flatMap(row => row.invocations ?? []) ?? []
}
export async function waitEvalRun(stores: ProjectStores, id: string): Promise<EvalRun> {
  evalId(id)
  await jobs.get(jobKey(stores, id))
  return getEvalRun(stores, id)
}

export async function runEval(original: EngineDeps, input: EvalRunRequest, by: Actor = { type: 'system', id: 'eval' }): Promise<EvalRun> {
  by = structuredClone(by)
  const request = structuredClone(input)
  targetName(request.target)
  if (!request.variants?.length) throw new Error('必须提供至少一个变体；请填写 variants')
  const resolved = await resolveVariantPaths(original.stores, request.variants)
  const baseline = resolved.find(v => v.id === 'baseline') ?? { id: 'baseline', label: '当前配方' }
  const variants: EvalVariant[] = [baseline, ...resolved.filter(v => v !== baseline)]
  if (new Set(variants.map(v => evalId(v.id))).size !== variants.length) throw new Error('变体 id 重复；请使用唯一 id')
  const cases = (await listEvalCases(original.stores, request.target)).filter(value => !request.caseIds || request.caseIds.includes(value.id))
  if (!cases.length || request.caseIds?.some(id => !cases.some(value => value.id === id))) throw new Error('评测用例不存在或已退役；请重新选择样本')
  const config = structuredClone(original.stores.config)
  const deps: EngineDeps = { ...original, stores: { ...original.stores, config }, profiles: structuredClone(original.profiles) }
  const repeats = request.repeats ?? config.eval?.repeats ?? 3
  if (!Number.isSafeInteger(repeats) || repeats < 1) throw new Error('重复次数必须是正整数；请设置 repeats')
  const gate = structuredClone(config.eval?.gate)
  validateEvalGate(gate)
  const run: EvalRun = { id: `eval-${randomUUID()}`, target: request.target, variants: variants.map(v => {
    const requested = request.variants.find(r => r.id === v.id)
    return requested ?? { id: v.id, label: v.label }
  }), caseIds: cases.map(c => c.id), status: 'running', startedAt: new Date().toISOString(), by, results: [], repeats, candidates: {} }
  const reason = request.reason?.trim() || '启动只读检查点评测'
  const sources = new Map<string, ReplaySource>(), plans: ReplayPlan[] = []
  const reasons: string[] = [], isolations: NonNullable<EvalRun['isolation']>[] = []
  let judge: Parameters<typeof judgeReplay>[4] | undefined
  try {
    for (const value of cases) {
      validateEvalCase(value)
      if (!value.sample) throw new Error(`用例 ${value.id} 是旧整节点用例；本期拒绝写代码 / 整节点回放，请从只读检查点创建样本`)
      const source = await replaySource(deps.stores, value.sample.checkpointId, value.source.runId, value.source.nodeId)
      if (source.run.runId !== value.source.runId || source.checkpoint.nodeId !== value.source.nodeId) throw new Error('样本源运行与检查点不一致；请重新创建样本')
      if (source.snapshot.dir !== value.sample.snapshot) throw new Error('样本与检查点快照不一致；请重新创建样本')
      if (value.sample.kind === 'must_catch') {
        const defect = (await qualityStore(deps.stores).defects(source.run.requirementId)).find(d => d.id === value.source.defectId)
        if (!defect || !confirmedMiss(defect, defect.attribution, source.checkpoint.id)) throw new Error('样本漏检归因尚未确认或已改判；请重新确认后启动评测')
      }
      sources.set(value.id, source)
    }
    for (const variant of variants) {
      const candidate = await freezeEvalCandidate(deps, variant)
      run.candidates![variant.id] = candidate.id
      for (const value of cases) {
        const source = sources.get(value.id)!, profile = await candidateProfile(candidate, source.invocation.agentRole ?? source.checkpoint.subject)
        const selector = replaySelector(source, candidate, profile)
        plans.push({ value, source, candidate, profile, selector })
      }
    }
    const selector = selectHarness('evaluator', request.judge, { ...deps, config })
    const candidate = await freezeEvalCandidate(deps, { id: 'judge', label: '固定评委', harness: selector })
    const profile = await candidateProfile(candidate, 'evaluator')
    judge = { candidate, profile, selector, recipeKey: judgeRecipe(candidate, profile, selector) }
    for (const plan of [...plans, judge]) for (const choice of harnessSelectors(plan.selector)) {
      const selected = resolveHarnessSelector(choice, config, deps.harnesses, deps.bridge)
      const isolation = await preflightIsolation(deps, selected.harness)
      isolations.push(isolation)
      if (!isolation.ok) reasons.push(...isolation.reasons ?? [])
    }
  } catch (error) { reasons.push(errorText(error)) }
  run.isolation = { ok: !reasons.length, mode: isolations.some(i => i.mode === 'simulated') ? 'simulated'
    : isolations.some(i => i.mode === 'harness_readonly') ? 'harness_readonly' : isolations.length ? 'sandbox' : undefined,
    reasons: [...new Set([...reasons, ...isolations.filter(i => i.mode === 'simulated').flatMap(i => i.reasons ?? [])])] }
  run.report = buildEvalReport(cases, variants, repeats, [], { gate, isolation: run.isolation, judgeRecipeKey: judge?.recipeKey })
  run.frozenCases = structuredClone(cases)
  run.judgeCandidate = judge?.candidate.id
  if (reasons.length) { run.status = 'refused'; run.endedAt = new Date().toISOString() }
  await appendEvalObject(deps.stores, 'eval.started', run, { by, reason, baseRevision: evalRevision(undefined) })
  if (run.status === 'refused') {
    await appendEvalObject(deps.stores, 'eval.finished', run, { by, reason: `拒绝启动：${reasons.join('；')}`, baseRevision: evalRevision(run) })
    return run
  }
  const frozenJudge = judge!, initial = structuredClone(run)
  const job = (async () => {
    const rows: ReplayOutput[] = []
    try {
      for (const plan of plans) for (let repeat = 0; repeat < repeats; repeat++) rows.push(await executeReplay(deps, run.id, plan, repeat))
      // 固定种子使同一冻结计划的展示顺序可复验；展示给评委的载荷不含该种子和组别。
      const seed = frozenJudge.recipeKey + cases.map(c => c.id).join(':')
      for (const row of blindOrder(rows, seed)) await judgeReplay(deps, run.id, row, cases.find(c => c.id === row.caseId)!, frozenJudge)
      run.results = rows.map(row => row.result)
      run.report = buildEvalReport(cases, variants, repeats, rows, { gate, isolation: run.isolation, judgeRecipeKey: frozenJudge.recipeKey })
      // 旧 comparison 每例只能放一个结果；必须汇总全部重复，不能只挑第一次。
      const aggregated = cases.flatMap(value => variants.map(variant => {
        const matches = rows.filter(r => r.caseId === value.id && r.variant === variant.id)
        return { caseId: value.id, variant: variant.id, pass: matches.length === repeats && matches.every(r => r.verdict.outcome === 'pass'),
          score: matches.filter(r => r.verdict.outcome === 'pass').length / repeats * 100, usage: { inputTokens: 0, outputTokens: 0 }, durationMs: 0 }
      }))
      if (variants[1]) {
        run.comparison = compareEval(cases, aggregated, baseline.id, variants[1].id)
        if (run.report.exploratory || run.report.gate?.verdict !== 'pass') run.comparison.verdict = 'inconclusive'
      }
      run.status = 'done'
    } catch (error) {
      run.status = 'failed'
      run.isolation!.reasons = [...run.isolation!.reasons ?? [], `评测中断：${errorText(error)}；请检查环境后重新执行`]
      run.results = rows.map(row => row.result)
      run.report = buildEvalReport(cases, variants, repeats, rows, { gate, isolation: run.isolation, judgeRecipeKey: frozenJudge.recipeKey })
    } finally {
      run.endedAt = new Date().toISOString()
      // 原始匿名输出、评委结论与候选包身份跟随运行一起入账，读模型可重建。
      const persisted = { ...run, replayEvidence: rows, judgeCandidate: frozenJudge.candidate.id, frozenCases: cases }
      await appendEvalObject(deps.stores, 'eval.finished', persisted, { by, reason: `${reason}：结束并记录逐次证据`, baseRevision: evalRevision(initial) })
    }
  })()
  jobs.set(jobKey(deps.stores, run.id), job)
  void job.finally(() => jobs.delete(jobKey(deps.stores, run.id))).catch(() => {})
  return initial
}
