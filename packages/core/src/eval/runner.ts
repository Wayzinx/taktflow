import { randomUUID } from 'node:crypto'
import { cp, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { EngineDeps, ProjectStores } from '../interfaces.js'
import type { EvalRunRequest } from '../api.js'
import type { Actor, AgentNodeDef, AgentProfile, CompletionCheck, EvalCase, EvalCaseResult, EvalComparison, EvalRun, EvalVariant, HarnessSelector } from '../types.js'
import { initProject, loadProfiles } from '../store/project.js'
import { assertNoSymlinks, fileExists, readJsonFile } from '../store/fs-utils.js'
import { taskWorkflow } from '../lead/task.js'
import { createEngine } from '../engine/index.js'
import { harnessSelectors, resolveHarnessSelector, selectHarness } from '../engine/selection.js'
import { executionAdapters } from '../engine/execution.js'
import { addUsage } from '../insights/usage.js'
import { parseFrontmatter } from '../util/frontmatter.js'
import type { FrozenNode } from '../engine/recipe-record.js'
import { resolveVariantPaths } from './variant-paths.js'
import { recipeOf } from '../engine/recipe.js'
import { listEvalCases, validateEvalCase } from './cases.js'
import { evalId, jsonFiles, jsonWrite, targetName } from './storage.js'
import { readOnlyModel } from './model.js'

const jobs = new Map<string, Promise<void>>()
const rootOf = (stores: ProjectStores) => join(stores.taktDir, 'evals', 'runs')
const jobKey = (stores: ProjectStores, id: string) => `${stores.projectDir}:${id}`
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error)
const scoreSchema = { type: 'object', required: ['score', 'reason'], properties: { score: { type: 'number' }, reason: { type: 'string' } } }
const checkSchema = { type: 'array', items: { type: 'object', required: ['id', 'criterion', 'pass', 'evidence'], properties: {
  id: { type: 'string' }, criterion: { type: 'string' }, pass: { type: 'boolean' }, evidence: { type: 'string' },
} } }
const gradeSchema = { type: 'object', required: ['checks', 'score', 'reason'], properties: {
  checks: checkSchema, score: { type: 'number' }, reason: { type: 'string' },
} }
interface Grade { checks: CompletionCheck[]; score: number; reason: string; rubric?: { score: number; reason: string }; reference?: { score: number; reason: string } }

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

async function variantProfile(deps: EngineDeps, value: EvalCase, variant: EvalVariant): Promise<AgentProfile> {
  const role = value.node.role
  if (!role || !deps.profiles[role]) throw new Error(`被测角色不存在：${role}`)
  if (!variant.profileFile) return structuredClone(deps.profiles[role])
  const dir = await mkdtemp(join(tmpdir(), 'takt-profile-'))
  try {
    await cp(variant.profileFile, join(dir, `${role}.md`))
    const loaded = await loadProfiles({ ...deps.stores.paths, agents: dir })
    if (!loaded[role]) throw new Error(`覆盖档案必须声明同一角色：${role}`)
    const { data } = parseFrontmatter(await readFile(variant.profileFile, 'utf8'))
    if (data.allowBash !== undefined && typeof data.allowBash !== 'boolean') throw new Error('角色 allowBash 必须为 boolean')
    return { ...loaded[role], allowBash: data.allowBash === true }
  } finally { await rm(dir, { recursive: true, force: true }) }
}
async function testedSelector(deps: EngineDeps, value: EvalCase, variant: EvalVariant, profile: AgentProfile): Promise<HarnessSelector> {
  if (variant.harness) return variant.harness
  if (variant.profileFile) return profile.harness
  if (value.source.runId && value.source.nodeId) {
    const recipe = recipeOf(await deps.stores.events.read(value.source.runId), value.source.nodeId)
    if (recipe?.harness) return { harness: recipe.harness, model: recipe.model, effort: recipe.effort }
  }
  return value.node.harness ? { ...profile.harness, harness: value.node.harness } : profile.harness
}
function judgeSelector(deps: EngineDeps, value: EvalCase, request: EvalRunRequest): HarnessSelector {
  return selectHarness('evaluator', request.judge ?? value.grading.rubric?.judge, { ...deps, config: deps.stores.config })
}
function validateJudge(deps: EngineDeps, tested: HarnessSelector, judge: HarnessSelector) {
  const b = resolveHarnessSelector(judge, deps.stores.config, deps.harnesses)
  for (const selector of harnessSelectors(tested)) {
    const a = resolveHarnessSelector(selector, deps.stores.config, deps.harnesses)
    if (a.model ? !b.model || a.model === b.model : a.harness.id === b.harness.id && a.model === b.model) {
      throw new Error('判分模型必须明确指定且不同于被测模型（包括 fallback）；被测无模型时 harness / 模型组合必须不同')
    }
  }
}
function completionCriteria(value: EvalCase): string[] { return [...new Set([...(value.node.completion ?? []), ...(value.grading.checks ?? [])])] }
function graded(value: EvalCase): boolean {
  return !!(completionCriteria(value).length || value.grading.rubric || value.grading.reference || value.grading.mustFind?.length || value.grading.mustNotIntroduce?.length)
}
async function evaluate(deps: EngineDeps, request: EvalRunRequest, run: EvalRun, value: EvalCase, variant: EvalVariant): Promise<EvalCaseResult> {
  const start = Date.now(), dir = await mkdtemp(join(tmpdir(), 'takt-eval-'))
  const result: EvalCaseResult = { caseId: value.id, variant: variant.id, pass: false, usage: { inputTokens: 0, outputTokens: 0 }, durationMs: 0 }
  try {
    const stores = await initProject(dir)
    stores.config = { ...deps.stores.config, project: { name: 'isolated-eval' }, repos: [], workflows: [] }
    const req = await stores.workspaces.createRequirement({ id: 'REQ-EVAL', title: value.title })
    for (const input of value.inputs) await stores.workspaces.writeArtifact({ ref: { workspace: req.id, path: input.path }, content: input.content, kind: input.kind ?? 'input', author: { type: 'system', id: 'eval' } })
    const profile = await variantProfile(deps, value, variant)
    const selector = await testedSelector(deps, value, variant, profile)
    let prompt = variant.promptFile ? await readFile(variant.promptFile, 'utf8') : value.prompt ?? value.node.prompt
    if (!prompt?.trim()) throw new Error('没有冻结的实际 prompt，不能回放')
    // 实际 prompt 中的旧绝对路径必须指向本次冻结输入，不能回写原需求。
    if (value.source.runId) {
      const original = await deps.stores.runs.get(value.source.runId)
      if (original) prompt = prompt.split(deps.stores.workspaces.dir(original.requirementId)).join(stores.workspaces.dir(req.id))
    }
    prompt = prompt.split(deps.stores.projectDir).join(dir)
    const task = taskWorkflow({ role: profile.role, title: value.title, instructions: prompt, inputs: value.inputs.map((input) => input.path),
      outputs: value.node.outputs, writeScope: value.node.writeScope, completion: value.node.completion, review: false }, stores, { ...deps.profiles, [profile.role]: profile })
    const node = task.workflow.nodes[0] as AgentNodeDef
    node.resultSchema = (value.node as FrozenNode).resultSchema
    if (!variant.promptFile && ((value.node as FrozenNode).replayPromptKind === 'assembled-legacy' || !(value.node as FrozenNode).replayPromptKind && !value.node.prompt)) {
      await deps.stores.events.append(run.id, { type: 'log', actor: { type: 'system', id: 'eval' }, data: { level: 'warn', message: `旧用例 ${value.id} 缺少 prompt 模板，回退到已组装 prompt；对比结构可能不同` } })
    }
    node.harness = selector; node.timeoutMs = 120000; node.strictOutputs = true
    const state = await createEngine({ stores, profiles: task.profiles, harnesses: deps.harnesses, knowledge: [], sandbox: deps.sandbox,
      skillsDir: variant.skillsDir ?? deps.skillsDir ?? deps.stores.paths.skills }).start({ workflow: task.workflow, requirementId: req.id, kind: 'task' })
    const ns = state.nodes.task!
    result.usage = ns.usage ?? result.usage
    const executionEvents = await stores.events.read(state.runId)
    const actual = executionEvents.filter((event) => event.type === 'harness.message' && (event.data as { role: string }).role === 'user').at(-1)?.actor
    if (graded(value) && actual?.type === 'agent') validateJudge(deps, { harness: actual.harness, model: actual.model }, judgeSelector(deps, value, request))
    const outputDir = join(rootOf(deps.stores), run.id, evalId(value.id), evalId(variant.id))
    await assertNoSymlinks(deps.stores.taktDir, outputDir)
    await cp(stores.workspaces.dir(req.id), outputDir, { recursive: true, filter: (source) => !['/manifest.json', '/requirement.json', '/comments.jsonl'].some((suffix) => source.endsWith(suffix)) })
    result.outputDir = outputDir
    const outputs: Array<{ path: string; content: string }> = []
    for (const ref of ns.outputs) outputs.push({ path: ref.path, content: (await stores.workspaces.readArtifact(ref))?.toString() ?? '' })
    await jsonWrite(deps.stores.taktDir, join(outputDir, 'eval-output.json'), { outputs, result: ns.result, status: state.status, error: ns.error })
    if (state.status !== 'succeeded') throw new Error(ns.error ?? `回放运行状态：${state.status}`)
    const checks: CompletionCheck[] = []
    for (const [index, command] of (value.grading.commands ?? []).entries()) {
      const provider = deps.sandbox ?? await (await executionAdapters()).selectSandboxProvider(stores.config.sandbox)
      const sandbox = await provider.create({ workdir: outputDir, mounts: [{ source: outputDir, target: outputDir, mode: 'rw' }], network: 'none', limits: { timeoutMs: 60000 } })
      try {
        const executed = await sandbox.exec('sh', ['-c', command], { timeoutMs: 60000 })
        checks.push({ id: `command-${index + 1}`, criterion: command, pass: executed.code === 0, evidence: `exit=${executed.code}\n${executed.stdout}\n${executed.stderr}` })
      } finally { await sandbox.dispose() }
    }
    for (const output of outputs) {
      await assertNoSymlinks(outputDir, join(outputDir, output.path))
      output.content = await readFile(join(outputDir, output.path), 'utf8')
    }
    if (graded(value)) {
      if (profile.role === 'evaluator') throw new Error('evaluator 必须独立于被测角色')
      const judge = judgeSelector(deps, value, request)
      validateJudge(deps, selector, judge)
      const criteria = [...completionCriteria(value), ...(value.grading.mustFind ?? []).map((issue) => `必须指出：${issue}`), ...(value.grading.mustNotIntroduce ?? []).map((issue) => `不得引入：${issue}`)]
      const schema = { ...gradeSchema, required: [...gradeSchema.required, ...(value.grading.rubric ? ['rubric'] : []), ...(value.grading.reference ? ['reference'] : [])], properties: { ...gradeSchema.properties, rubric: scoreSchema, reference: scoreSchema } }
      const response = await readOnlyModel(deps, 'evaluator', `独立核对输出与证据，不采信被测节点的自报。checks 必须按 c1,c2... 返回每条 criterion 的 pass 和非空 evidence 字符串。score 为 0–100，rubric 与 reference 必须分别返回各自的 score 和 reason，score 是总体分数。\n${JSON.stringify({ criteria, grading: value.grading, inputs: value.inputs, outputs, commandEvidence: checks, result: ns.result })}\n输出 JSON schema: ${JSON.stringify(schema)}`, schema, judge)
      result.usage = addUsage(result.usage, response.usage)
      const grade = response.data as Grade
      if (!Number.isFinite(grade.score) || grade.score < 0 || grade.score > 100 || !grade.reason.trim()) throw new Error('判分结果无效')
      for (const [index, criterion] of criteria.entries()) {
        const matches = grade.checks.filter((item) => item.id === `c${index + 1}`)
        const match = matches[0]
        if (matches.length !== 1 || !match || !match.evidence?.trim()) throw new Error(`独立核验缺少有效证据：${criterion}`)
        checks.push(match)
      }
      result.score = grade.score
      for (const field of ['rubric', 'reference'] as const) if (value.grading[field]) {
        const rating = grade[field]
        if (!rating || !Number.isFinite(rating.score) || rating.score < 0 || rating.score > 100 || !rating.reason.trim()) throw new Error(`${field} 判分结果无效`)
        result[field] = rating
      }
    }
    result.checks = checks
    result.pass = checks.every((check) => check.pass) && (!value.grading.rubric || (result.rubric?.score ?? 0) >= value.grading.rubric.threshold)
    result.score ??= result.pass ? 100 : 0
  } catch (error) { result.error = errorText(error) }
  finally { result.durationMs = Date.now() - start; await rm(dir, { recursive: true, force: true }) }
  return result
}

export async function getEvalRun(stores: ProjectStores, id: string): Promise<EvalRun> {
  const file = join(rootOf(stores), `${evalId(id)}.json`)
  await assertNoSymlinks(stores.taktDir, file)
  const run = await readJsonFile<EvalRun>(file)
  if (!run) throw new Error(`评测运行不存在：${id}`)
  return run
}
export async function listEvalRuns(stores: ProjectStores): Promise<EvalRun[]> {
  return (await jsonFiles<EvalRun>(rootOf(stores))).sort((a, b) => b.startedAt.localeCompare(a.startedAt)).map((run) => ({ ...run, results: [] }))
}
export async function waitEvalRun(stores: ProjectStores, id: string): Promise<EvalRun> {
  await jobs.get(jobKey(stores, id))
  return getEvalRun(stores, id)
}
export async function runEval(deps: EngineDeps, request: EvalRunRequest, by: Actor = { type: 'system', id: 'eval' }): Promise<EvalRun> {
  targetName(request.target)
  if (!Array.isArray(request.variants) || !request.variants.length) throw new Error('必须提供至少一个变体')
  const resolvedVariants = await resolveVariantPaths(deps.stores, request.variants)
  const cases = (await listEvalCases(deps.stores, request.target)).filter((value) => !request.caseIds || request.caseIds.includes(value.id))
  if (!cases.length) throw new Error('没有匹配的评测用例')
  if (request.caseIds?.some((id) => !cases.some((value) => value.id === id))) throw new Error('选中的评测用例不存在')
  if (!Array.isArray(request.variants) || !request.variants.length) throw new Error('必须提供至少一个变体')
  const variants = resolvedVariants.some((variant) => variant.id === 'baseline') ? resolvedVariants : [{ id: 'baseline', label: '当前配方' }, ...resolvedVariants]
  if (new Set(variants.map((variant) => evalId(variant.id))).size !== variants.length) throw new Error('变体 id 重复')
  for (const value of cases) {
    validateEvalCase(value)
    if (value.node.kind !== 'agent') throw new Error(`MVP 只支持 agent 节点回放：${value.node.id}`)
    for (const variant of variants) {
      const profile = await variantProfile(deps, value, variant)
      if (graded(value)) { if (profile.role === 'evaluator') throw new Error('evaluator 必须独立于被测角色'); validateJudge(deps, await testedSelector(deps, value, variant, profile), judgeSelector(deps, value, request)) }
    }
  }
  const run: EvalRun = { id: `eval-${randomUUID()}`, target: request.target, variants, caseIds: cases.map((value) => value.id), status: 'running', startedAt: new Date().toISOString(), by, results: [] }
  const persist = () => jsonWrite(deps.stores.taktDir, join(rootOf(deps.stores), `${run.id}.json`), run)
  for (const value of cases) await jsonWrite(deps.stores.taktDir, join(rootOf(deps.stores), run.id, 'cases', `${evalId(value.id)}.json`), value)
  const executionVariants: EvalVariant[] = []
  for (const variant of variants) {
    const frozen = { ...variant }, dir = join(rootOf(deps.stores), run.id, 'variants', variant.id)
    for (const [field, source] of [['skillsDir', variant.skillsDir ?? deps.skillsDir ?? deps.stores.paths.skills], ['promptFile', variant.promptFile], ['profileFile', variant.profileFile]] as const) {
      if (!source) continue
      if (!await fileExists(source)) { if (field === 'skillsDir' && !variant.skillsDir) continue; throw new Error('变体路径无效') }
      const destination = join(dir, field)
      await assertNoSymlinks(deps.stores.taktDir, destination)
      await cp(source, destination, { recursive: true })
      frozen[field] = destination
    }
    executionVariants.push(frozen)
  }
  // 变体文件副本与冻结用例一起落盘，后续后台执行不重新读取用户正在编辑的文件。
  await jsonWrite(deps.stores.taktDir, join(rootOf(deps.stores), run.id, 'execution-variants.json'), executionVariants)
  const frozenDeps = { ...deps, profiles: structuredClone(deps.profiles) }
  await persist()
  const initial = structuredClone(run)
  const job = (async () => {
    try {
      for (const value of cases) for (const variant of executionVariants) { run.results.push(await evaluate(frozenDeps, request, run, value, variant)); await persist() }
      const baseline = variants.find((variant) => variant.id === 'baseline')!, candidate = variants.find((variant) => variant.id !== baseline.id)
      if (candidate) run.comparison = compareEval(cases, run.results, baseline.id, candidate.id)
      await jsonWrite(deps.stores.taktDir, join(rootOf(deps.stores), run.id, 'comparisons.json'), variants.filter((variant) => variant.id !== baseline.id).map((variant) => compareEval(cases, run.results, baseline.id, variant.id)))
      run.status = 'done'
    } catch (error) {
      run.status = 'failed'
      await deps.stores.events.append(run.id, { type: 'log', actor: by, data: { level: 'error', message: errorText(error) } })
    } finally { run.endedAt = new Date().toISOString(); await persist(); jobs.delete(jobKey(deps.stores, run.id)) }
  })()
  jobs.set(jobKey(deps.stores, run.id), job)
  void job.catch(() => {})
  return initial
}
