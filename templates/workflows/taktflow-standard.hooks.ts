import { mkdir, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'
import {
  agent, archiveCaseEvidence, assertNoSymlinks, bindWorkspaceQaCommand, captureGitSnapshot,
  diffExecutionAssets, environmentCommandVariable, environmentFailure, executionEvidenceDir, newExecutionId, readExecutionReceipts,
  review, runEnvironmentCaseCommand, selectWorkspaceQaIntegration, sha256, snapshotExecutionAssets,
  writeExecutionReceipt, EnvironmentCommandCancelledError,
  type EnvironmentCommandResult, type ExecutionArchiveResult, type ExecutionAssetDiff,
  type ExecutionAssetSnapshot, type ExecutionGitSnapshot, type ExecutionReceiptRef,
  type JudgeVerdict, type NodeContext, type PlannedItem,
} from '@taktflow/core'

const acId = /\bAC-\d+(?:-\d+)?\b/g
interface CaseFile { id: string; covers: string[] }
interface Summary { cases: Array<{ id: string; status: string; evidence?: string }> }
async function put(ctx: NodeContext, path: string, text: string) {
  await mkdir(dirname(join(ctx.workspaceDir, path)), { recursive: true })
  await writeFile(join(ctx.workspaceDir, path), text)
}
async function cases(ctx: NodeContext): Promise<CaseFile[]> {
  const files = (await readdir(join(ctx.workspaceDir, 'cases'))).filter((file) => file.endsWith('.json')).sort()
  return Promise.all(files.map(async (file) => JSON.parse((await ctx.readArtifact(`cases/${file}`))!) as CaseFile))
}
async function summary(ctx: NodeContext): Promise<Summary> {
  return JSON.parse((await ctx.readArtifact('evidence/summary.json')) ?? '{"cases":[]}') as Summary
}
export async function traceCoverage(ctx: NodeContext) {
  const acs = new Set(((await ctx.readArtifact('spec/prd.md')) ?? '').match(acId) ?? [])
  const tests = await cases(ctx)
  const covered = new Set(tests.flatMap((test) => test.covers))
  const uncovered = [...acs].filter((ac) => !covered.has(ac))
  const orphan = tests.filter((test) => !test.covers.some((ac) => acs.has(ac)))
  return { id: 'ac-covered', pass: acs.size > 0 && uncovered.length === 0 && orphan.length === 0, message: `AC ${acs.size} 条，未覆盖 ${uncovered.length}，孤立用例 ${orphan.length}` }
}
export async function freezeBaseline(ctx: NodeContext) {
  const tests = await cases(ctx)
  await put(ctx, 'decisions/baseline.json', JSON.stringify({ runId: ctx.runId, frozenAt: new Date().toISOString(), cases: tests.map((test) => test.id) }, null, 2))
}
export function expandTask(item: PlannedItem) {
  const repo = String(item.params?.repo ?? 'app')
  return [
    agent({ id: 'code', title: `实现：${item.title}`, role: item.role ?? 'dev', repo, owner: 'rd', goal: '实现任务并提供改动与自测证据', completion: ['任务改动与自测结果均有可核查证据'],
      inputs: [{ path: 'spec/prd.md' }, { path: 'design/**' }],
      outputs: [{ path: `tasks/${item.key}.md`, kind: 'task' }, { path: `tasks/${item.key}.diff`, kind: 'code-change' }],
      prompt: `实现任务 ${item.key}「${item.title}」，仓库 ${repo}。在 tasks/${item.key}.md 写改动说明与自测证据，并把本任务统一 diff 写到 tasks/${item.key}.diff。` }),
    review({ id: 'review-code', title: `代码评审：${item.title}`, needs: ['code'], target: { code: { repo } },
      author: { role: item.role ?? 'dev' }, reviewers: [{ role: 'reviewer', focus: '正确性、复用、风险；审查 diff 与契约' }],
      maxRounds: 3, humanSignoff: true, onExhausted: { rework: 'code', maxReworks: 1 } }),
  ]
}
/** 解析本次运行的集成工作树；没有 integration 节点（环境测试复用）时回退空间根。 */
async function integrationCwd(ctx: NodeContext): Promise<{ cwd: string; error?: string }> {
  const result = ctx.resultOf('integration')
  if (result === undefined) return { cwd: ctx.projectDir }
  const repo = typeof ctx.args.repo === 'string' && ctx.args.repo.trim() !== '' ? ctx.args.repo.trim() : 'app'
  const selected = selectWorkspaceQaIntegration(result, ctx.runId, repo, ctx.projectDir)
  if (selected.kind === 'error') return { cwd: ctx.projectDir, error: selected.error }
  try {
    await assertNoSymlinks(ctx.projectDir, selected.integration.path)
    const cwd = await realpath(selected.integration.path)
    const root = await realpath(ctx.projectDir)
    const rel = relative(root, cwd)
    if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      return { cwd: ctx.projectDir, error: `integration 工作树必须位于空间根内的独立目录：${selected.integration.path}` }
    }
    if (!(await stat(cwd)).isDirectory()) return { cwd: ctx.projectDir, error: `integration 工作树不是目录：${selected.integration.path}` }
    return { cwd }
  } catch (error) {
    return { cwd: ctx.projectDir, error: `integration 工作树不可用：${error instanceof Error ? error.message : String(error)}` }
  }
}

const message = (error: unknown) => error instanceof Error ? error.message : String(error)
interface CaseRow { id: string; status: string; evidence?: string }

/** 只解析 runner 产出的 cases 行；非法 JSON 原样保留错误，不猜测结论。 */
function caseRows(value: unknown): CaseRow[] {
  if (!Array.isArray(value)) return []
  const rows: CaseRow[] = []
  for (const item of value) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) continue
    const row = item as Record<string, unknown>
    if (typeof row.id !== 'string' || row.id === '' || typeof row.status !== 'string') continue
    rows.push({ id: row.id, status: row.status, ...(typeof row.evidence === 'string' && row.evidence !== '' ? { evidence: row.evidence } : {}) })
  }
  return rows
}

interface RunCasesExecution {
  executionId: string
  executionDir: string
  startedAt: string
  started: number
  configured: string
  testScript: string
  baselineRevision?: string
  baselineSource?: 'environment.env' | 'host-process'
  baselineError?: string
  prior?: ExecutionArchiveResult
  priorError?: string
  assetsBefore?: ExecutionAssetSnapshot
  assetsError?: string
  gitBefore?: ExecutionGitSnapshot
}

interface SummarySnapshot {
  digest?: string
  cases: CaseRow[]
  error?: string
}

async function readSummaryFile(ctx: NodeContext): Promise<SummarySnapshot> {
  let text: string
  try {
    text = await readFile(join(ctx.workspaceDir, 'evidence/summary.json'), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { cases: [] }
    return { cases: [], error: message(error) }
  }
  try {
    const parsed: unknown = JSON.parse(text)
    const rows = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as { cases?: unknown }).cases : undefined
    return { digest: sha256(text), cases: caseRows(rows) }
  } catch (error) {
    return { digest: sha256(text), cases: [], error: `summary 不是有效 JSON：${message(error)}` }
  }
}

/** 只追加执行元数据，保留 runner 产出的 cases/status/assertions 原样。 */
async function stampSummary(ctx: NodeContext, execution: Record<string, unknown>): Promise<{ updated: boolean; error?: string }> {
  try {
    const file = join(ctx.workspaceDir, 'evidence/summary.json')
    const text = await readFile(file, 'utf8')
    const parsed: unknown = JSON.parse(text)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { updated: false, error: 'summary 不是对象，未写入执行元数据' }
    }
    const record = parsed as Record<string, unknown>
    const next = {
      ...record,
      ...(typeof record.generatedAt === 'string' && record.generatedAt !== '' ? {} : { generatedAt: execution.endedAt }),
      execution,
    }
    await writeFile(file, `${JSON.stringify(next, null, 2)}\n`)
    return { updated: true }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { updated: false }
    return { updated: false, error: message(error) }
  }
}

/** 每次正式 runCases 调用都先归档旧 summary/逐例证据，再固定入口目录树资产。 */
async function beginRunCasesExecution(ctx: NodeContext, testScript: string, configured: string, cwd: string): Promise<RunCasesExecution> {
  const executionId = newExecutionId(ctx.iteration)
  const executionDir = executionEvidenceDir(ctx.runId, ctx.nodeId, executionId)
  const startedAt = new Date().toISOString()
  const started = Date.now()
  // 只记录用例命令实际会拿到的基线：config.env（含 ${} 解析）优先，其次宿主进程环境；
  // 不读取无关全局变量，也不猜测缺失值。
  const baseline = await environmentCommandVariable(ctx, 'TAKT_REGRESSION_BASELINE_REV')
  const baselineRevision = typeof baseline.value === 'string' && baseline.value.trim() !== '' ? baseline.value.trim() : undefined
  let prior: ExecutionArchiveResult | undefined
  let priorError: string | undefined
  try {
    prior = await archiveCaseEvidence({ workspaceDir: ctx.workspaceDir, archiveDir: executionDir, label: 'prior' })
  } catch (error) {
    priorError = message(error)
  }
  let assetsBefore: ExecutionAssetSnapshot | undefined
  let assetsError: string | undefined
  try {
    assetsBefore = await snapshotExecutionAssets(ctx.projectDir, testScript)
  } catch (error) {
    assetsError = message(error)
  }
  // Git 身份必须来自实际执行命令的 cwd（integration 工作树），不是空间根。
  const gitBefore = await captureGitSnapshot(cwd, baselineRevision)
  return {
    executionId, executionDir, startedAt, started, configured, testScript,
    ...(baselineRevision === undefined ? {} : { baselineRevision }),
    ...(baseline.source === undefined ? {} : { baselineSource: baseline.source }),
    ...(baseline.error === undefined ? {} : { baselineError: baseline.error }),
    ...(prior === undefined ? {} : { prior }),
    ...(priorError === undefined ? {} : { priorError }),
    ...(assetsBefore === undefined ? {} : { assetsBefore }),
    ...(assetsError === undefined ? {} : { assetsError }),
    gitBefore,
  }
}

interface RunCasesOutcome {
  status: 'executed' | 'blocked' | 'cancelled' | 'timedOut'
  command: string
  cwd: string
  result?: EnvironmentCommandResult
  error?: string
  summary?: SummarySnapshot
  stamp?: boolean
}

/** 落盘不可变 receipt，并把执行关联写回当前 summary 的顶层元数据。 */
async function finishRunCasesExecution(
  ctx: NodeContext,
  state: RunCasesExecution,
  outcome: RunCasesOutcome,
): Promise<{ receipt?: ExecutionReceiptRef; receiptError?: string; summaryUpdated: boolean; summaryError?: string; assetsChanged: boolean }> {
  const endedAt = new Date().toISOString()
  const durationMs = Date.now() - state.started
  let assetsAfter: ExecutionAssetSnapshot | undefined
  let assetDiff: ExecutionAssetDiff | undefined
  if (state.assetsBefore !== undefined) {
    try {
      assetsAfter = await snapshotExecutionAssets(ctx.projectDir, state.testScript)
      assetDiff = diffExecutionAssets(state.assetsBefore, assetsAfter)
    } catch (error) {
      assetDiff = {
        before: state.assetsBefore.digest, after: '', changed: true, added: [], removed: [], modified: [],
        error: message(error),
      }
    }
  }
  const assetsChanged = assetDiff?.changed === true
  const gitAfter = await captureGitSnapshot(outcome.cwd, state.baselineRevision)
  const output = outcome.result?.output ?? ''
  let current: ExecutionArchiveResult | undefined
  let currentError: string | undefined
  try {
    current = await archiveCaseEvidence({
      workspaceDir: ctx.workspaceDir,
      archiveDir: state.executionDir,
      label: 'current',
      extra: [{ name: 'output.log', content: output }],
    })
  } catch (error) {
    currentError = message(error)
  }
  const summary = outcome.summary ?? await readSummaryFile(ctx)
  const summaryExecution = {
    executionId: state.executionId,
    receipt: `${state.executionDir}/receipt.json`,
    sourceDigest: state.assetsBefore?.digest ?? null,
    sourceFiles: state.assetsBefore?.files.length ?? 0,
    casesDigest: sha256(JSON.stringify(summary.cases)),
    startedAt: state.startedAt,
    endedAt,
    exitCode: outcome.result?.code ?? null,
    timedOut: outcome.result?.timedOut === true || outcome.status === 'timedOut',
    cancelled: outcome.result?.cancelled === true || outcome.status === 'cancelled',
    trusted: state.assetsError === undefined && !assetsChanged,
    executionAssetsChanged: assetsChanged,
  }
  const record = {
    schemaVersion: 1,
    kind: 'runCases',
    runId: ctx.runId,
    nodeId: ctx.nodeId,
    iteration: ctx.iteration ?? null,
    executionId: state.executionId,
    requirementId: ctx.requirementId,
    startedAt: state.startedAt,
    endedAt,
    durationMs,
    status: outcome.status,
    // 顶层可信度：资产在执行前后一致且快照成功；质量报告与审计直接读这里。
    trusted: state.assetsError === undefined && !assetsChanged,
    configuredCommand: state.configured,
    // 绑定命令在产出 result 前失败时，记录实际尝试执行的命令而不是配置命令。
    actualCommand: outcome.result?.command ?? outcome.command,
    cwd: outcome.cwd,
    exitCode: outcome.result?.code ?? null,
    timedOut: outcome.result?.timedOut === true || outcome.status === 'timedOut',
    cancelled: outcome.result?.cancelled === true || outcome.status === 'cancelled',
    error: outcome.error ?? null,
    sourceAssets: state.assetsBefore === undefined
      ? { error: state.assetsError ?? null }
      : {
        entry: state.assetsBefore.entry,
        directory: state.assetsBefore.directory,
        scope: state.assetsBefore.scope,
        digest: state.assetsBefore.digest,
        files: state.assetsBefore.files,
        afterDigest: assetsAfter?.digest ?? null,
        diff: assetDiff ?? null,
      },
    git: {
      cwd: outcome.cwd,
      before: state.gitBefore ?? null,
      after: gitAfter,
      baselineRevision: state.baselineRevision ?? null,
      baselineSource: state.baselineSource ?? null,
      baselineError: state.baselineError ?? null,
    },
    caseSummary: {
      path: 'evidence/summary.json',
      digest: summary.digest ?? null,
      cases: summary.cases,
      casesDigest: summaryExecution.casesDigest,
      error: summary.error ?? null,
    },
    archives: {
      prior: state.prior ?? null,
      current: current ?? null,
      priorError: state.priorError ?? null,
      currentError: currentError ?? null,
    },
    output: {
      path: current?.files.some((file) => file.path === 'output.log') === true ? 'current/output.log' : null,
      sha256: sha256(output),
      bytes: Buffer.byteLength(output),
      streams: 'combined',
    },
    summaryExecution,
  }
  let receipt: ExecutionReceiptRef | undefined
  let receiptError: string | undefined
  try {
    receipt = await writeExecutionReceipt(ctx.workspaceDir, state.executionDir, record)
  } catch (error) {
    receiptError = message(error)
  }
  const stamped = outcome.stamp === false ? { updated: false } : await stampSummary(ctx, summaryExecution)
  return {
    ...(receipt === undefined ? {} : { receipt }),
    ...(receiptError === undefined ? {} : { receiptError }),
    summaryUpdated: stamped.updated,
    ...(stamped.error === undefined ? {} : { summaryError: stamped.error }),
    assetsChanged,
  }
}

export async function runCases(ctx: NodeContext) {
  const failure = await environmentFailure(ctx)
  if (failure) return failure
  const testScript = String(ctx.args.testScript ?? 'tests/run-cases.mjs')
  const actual = await readFile(join(ctx.projectDir, testScript), 'utf8')
  if (actual !== await ctx.readArtifact('scripts/run-cases.mjs')) return { status: 'blocked' as const, message: '实际执行脚本与评审产物不一致' }
  const configured = String(ctx.args.caseCommand ?? 'npm test')
  // 先解析实际执行 cwd，Git 快照/脚本副本/命令都绑定同一个 integration 工作树。
  const resolved = await integrationCwd(ctx)
  const state = await beginRunCasesExecution(ctx, testScript, configured, resolved.cwd)
  const blocked = async (text: string, command = configured, cwd = resolved.cwd) => {
    await finishRunCasesExecution(ctx, state, { status: 'blocked', command, cwd, error: text, stamp: false })
    return { status: 'blocked' as const, message: text }
  }
  if (resolved.error !== undefined) return blocked(resolved.error)
  if (state.assetsError !== undefined) return blocked(`空间 QA 源资产快照失败：${state.assetsError}`)
  const cwd = resolved.cwd
  if (cwd !== ctx.projectDir) {
    await mkdir(dirname(join(cwd, testScript)), { recursive: true })
    await writeFile(join(cwd, testScript), actual)
  }
  // 复制到集成 worktree 的脚本只用于产物审计；实际执行空间根源脚本的绝对路径，
  // 否则脚本相对 import 的辅助模块会丢失，业务模块也会落到错误 cwd。
  const root = await realpath(ctx.projectDir)
  const binding = bindWorkspaceQaCommand(configured, testScript, root)
  if (binding.kind === 'error') return blocked(binding.error)
  let command = configured
  if (binding.kind === 'bound') {
    try {
      await assertNoSymlinks(root, binding.sourceScript)
      if (!(await stat(binding.sourceScript)).isFile()) throw new Error('脚本不是普通文件')
      command = binding.command
    } catch (error) {
      return blocked(`空间 QA 源脚本不可用：${message(error)}`)
    }
  }
  // 归档 prior 后再清空当前 summary；执行失败/取消时仍会归档本轮实际产出。
  await rm(join(ctx.workspaceDir, 'evidence/summary.json'), { force: true })
  let commandResult: EnvironmentCommandResult | undefined
  let commandError: string | undefined
  let thrown: unknown
  try {
    commandResult = await runEnvironmentCaseCommand(ctx, cwd, command)
  } catch (error) {
    thrown = error
    if (error instanceof EnvironmentCommandCancelledError) commandResult = error.result
    commandError = message(error)
  }
  // 命令在产出结果前失败（如环境变量解析失败）时记为 blocked，不谎报 executed。
  const status = commandResult === undefined ? 'blocked' as const
    : commandResult.timedOut === true ? 'timedOut' as const
    : commandResult.cancelled === true ? 'cancelled' as const
    : 'executed' as const
  const finished = await finishRunCasesExecution(ctx, state, {
    status,
    command,
    cwd,
    ...(commandResult === undefined ? {} : { result: commandResult }),
    ...(commandError === undefined ? {} : { error: commandError }),
  })
  if (thrown !== undefined) throw thrown
  // 执行期间源资产发生变化（含 helper）时本轮结果不可信，显式阻断而不是放行收敛。
  if (finished.assetsChanged) {
    return { status: 'blocked' as const, message: '空间 QA 源资产在执行期间发生变化，本轮执行不可信' }
  }
  const result = await summary(ctx)
  const expected = await cases(ctx)
  if (!result.cases.length || new Set(result.cases.map((test) => test.id)).size !== result.cases.length
    || expected.some((test) => !result.cases.some((row) => row.id === test.id))) {
    return { status: 'blocked' as const, message: '用例汇总缺失、重复或未覆盖冻结用例' }
  }
  return {
    data: {
      total: result.cases.length,
      failures: result.cases.filter((test) => test.status !== 'passed').map((test) => ({ subject: test.id, status: test.status, evidence: test.evidence })),
      executionId: state.executionId,
      receipt: finished.receipt?.path ?? null,
      trusted: !finished.assetsChanged && state.assetsError === undefined,
    },
  }
}
export function converged(ctx: NodeContext) {
  const result = ctx.resultOf('run-cases') as { failures?: unknown[] } | undefined
  return Array.isArray(result?.failures) && result.failures.length === 0
}
export function repairPrompt(target: string, instruction: string) {
  return function prompt(ctx: NodeContext) {
    const result = ctx.resultOf('judge') as { verdicts?: JudgeVerdict[]; routed?: Record<string, string[]> } | undefined
    const subjects = result?.routed?.[target] ?? []
    return `${instruction}\n${JSON.stringify((result?.verdicts ?? []).filter((verdict) => subjects.includes(verdict.subject)))}`
  }
}
export function codeWasFixed(ctx: NodeContext) {
  const result = ctx.resultOf('judge') as { routed?: Record<string, string[]> } | undefined
  return Boolean(result?.routed?.['fix-code']?.length)
}
interface FailureTrace {
  firstReceipt: string
  firstStatus: string
  firstArchive?: string
  lastReceipt: string
  lastStatus: string
  passedReceipt?: string
}

/** 汇总本运行所有 receipt 的失败/恢复轨迹，供影响面与准出审计追溯。 */
async function executionEvidenceSection(ctx: NodeContext): Promise<string[]> {
  let receipts: Awaited<ReturnType<typeof readExecutionReceipts>>
  try {
    receipts = await readExecutionReceipts(ctx.workspaceDir, ctx.runId)
  } catch (error) {
    return ['', '## 执行证据', '', `- receipt 读取失败：${message(error)}`]
  }
  const formal = receipts.receipts.filter((record) => record.receipt.kind === 'runCases')
  const lines = ['', '## 执行证据', '']
  if (formal.length === 0) {
    lines.push('- 当前运行没有可读取的 runCases 执行 receipt；执行证据目录：`evidence/executions/`。')
  } else {
    const latest = formal.at(-1)!
    const record = latest.receipt as {
      exitCode?: unknown
      trusted?: unknown
      sourceAssets?: { digest?: unknown; entry?: unknown; files?: unknown } | null
      archives?: { current?: { directory?: unknown } | null } | null
    }
    const files = Array.isArray(record.sourceAssets?.files) ? record.sourceAssets.files.length : 0
    lines.push(`- 当前执行 receipt：\`${latest.path}\`（sha256 \`${latest.sha256}\`）`)
    lines.push(`- 实际执行：exit=${String(record.exitCode ?? 'null')}，trusted=${record.trusted === true ? 'true' : 'false'}，源资产 ${files} 个文件，digest \`${typeof record.sourceAssets?.digest === 'string' ? record.sourceAssets.digest : 'n/a'}\`（入口 \`${typeof record.sourceAssets?.entry === 'string' ? record.sourceAssets.entry : 'n/a'}\`）。`)
    if (typeof record.archives?.current?.directory === 'string') {
      lines.push(`- 本轮用例证据归档：\`${record.archives.current.directory}\`（含 summary、逐例证据与合并日志）。`)
    }
  }
  const traces = new Map<string, FailureTrace>()
  const observe = (rows: CaseRow[], receipt: string, archive?: string): void => {
    for (const row of rows) {
      const existing = traces.get(row.id)
      if (row.status === 'passed') {
        if (existing !== undefined && existing.passedReceipt === undefined) existing.passedReceipt = receipt
        continue
      }
      if (existing === undefined) {
        traces.set(row.id, {
          firstReceipt: receipt,
          firstStatus: row.status,
          ...(archive === undefined ? {} : { firstArchive: archive }),
          lastReceipt: receipt,
          lastStatus: row.status,
        })
      } else {
        existing.lastReceipt = receipt
        existing.lastStatus = row.status
        delete existing.passedReceipt
      }
    }
  }
  for (const record of receipts.receipts) {
    const receipt = record.receipt as {
      caseSummary?: { cases?: unknown } | null
      archives?: { prior?: { directory?: unknown; cases?: unknown } | null } | null
    }
    const prior = receipt.archives?.prior
    observe(caseRows(prior?.cases), record.path, typeof prior?.directory === 'string' ? prior.directory : undefined)
    observe(caseRows(receipt.caseSummary?.cases), record.path)
  }
  const recovered = [...traces.entries()].filter(([, trace]) => trace.passedReceipt !== undefined)
  const open = [...traces.entries()].filter(([, trace]) => trace.passedReceipt === undefined)
  if (recovered.length === 0 && open.length === 0) {
    lines.push('- 本运行没有记录到失败用例。')
  }
  for (const [id, trace] of recovered) {
    lines.push(`- ${id}：首次 ${trace.firstStatus}（\`${trace.firstReceipt}\`${trace.firstArchive === undefined ? '' : `，失败证据归档 \`${trace.firstArchive}\``}）；后续通过（\`${trace.passedReceipt}\`）。`)
  }
  for (const [id, trace] of open) {
    lines.push(`- ${id}：最近 ${trace.lastStatus}（\`${trace.lastReceipt}\`），尚未恢复。`)
  }
  if (receipts.errors.length > 0) {
    lines.push(`- receipt 读取异常：${receipts.errors.map((item) => `${item.path}: ${item.error}`).join('；')}`)
  }
  return lines
}

export async function qualityReport(ctx: NodeContext) {
  const tests = await cases(ctx)
  const result = await summary(ctx)
  const acs = [...new Set(((await ctx.readArtifact('spec/prd.md')) ?? '').match(acId) ?? [])]
  const rows = acs.map((ac) => {
    const related = tests.filter((test) => test.covers.includes(ac))
    const passed = related.filter((test) => result.cases.some((row) => row.id === test.id && row.status === 'passed')).length
    return `| ${ac} | ${related.length} | ${passed} | ${related.length - passed} |`
  })
  const lines = [
    '# 质量报告', '', `用例 ${tests.length} 条，通过 ${result.cases.filter((test) => test.status === 'passed').length} 条。`,
    '', '| AC | 用例 | 通过 | 未通过 |', '|---|---|---|---|', ...rows,
  ]
  lines.push(...await executionEvidenceSection(ctx))
  await put(ctx, 'reports/quality.md', lines.join('\n'))
}
