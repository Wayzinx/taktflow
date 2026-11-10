import { execFile } from 'node:child_process'
import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { agent, review, type JudgeVerdict, type NodeContext, type PlannedItem } from '@taktflow/core'

const execute = promisify(execFile)
const acId = /\bAC-\d+(?:-\d+)?\b/g
interface CaseFile { id: string; covers: string[] }
interface Summary { cases: Array<{ id: string; status: string; evidence?: string }> }
// 等人工执行或等裁决的用例修不了：不进研发测试循环，留给质量报告和准出（manual_pending 视同 manual）
const awaitingHuman = (status: string) => ['manual', 'manual_pending', 'blocked'].includes(status)
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
      author: { role: item.role ?? 'dev' }, reviewers: [{ role: 'reviewer', focus: '正确性、复用、风险；审查 diff 与契约', checklist: ['实现字段与接口契约一致', '改动复用既有公共能力', '异常与边界行为有验证依据', '风险与回滚路径明确'] }],
      maxRounds: 3, humanSignoff: true, onExhausted: { rework: 'code', maxReworks: 1 } }),
  ]
}
export async function runCases(ctx: NodeContext) {
  const script = String(ctx.args.testScript ?? 'tests/run-cases.mjs')
  const actual = await readFile(join(ctx.projectDir, script), 'utf8')
  if (actual !== await ctx.readArtifact('scripts/run-cases.mjs')) return { status: 'blocked' as const, message: '实际执行脚本与评审产物不一致' }
  await rm(join(ctx.workspaceDir, 'evidence/summary.json'), { force: true })
  // 上一轮或别人留下的单条证据不能混进这一轮：按冻结用例清掉各自的证据目录，证据根目录下的基线等文件保留
  for (const test of await cases(ctx)) {
    if (/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(test.id)) await rm(join(ctx.workspaceDir, 'evidence', test.id), { recursive: true, force: true })
  }
  const integration = ctx.resultOf('integration') as { path?: string } | undefined
  const cwd = integration?.path ?? ctx.projectDir
  if (cwd !== ctx.projectDir) {
    // 测试由自动化写在空间根目录、不进任务分支：脚本所在目录（用例模块、公共库）整个带进集成 worktree，否则执行器只拿到一个文件
    const dir = dirname(script)
    if (dir !== '.') await cp(join(ctx.projectDir, dir), join(cwd, dir), { recursive: true, force: true })
    else await mkdir(cwd, { recursive: true })
    await writeFile(join(cwd, script), actual)
  }
  try {
    await execute('/bin/sh', ['-c', String(ctx.args.caseCommand ?? 'npm test')], {
      cwd, signal: ctx.signal, env: { ...process.env, TAKT_WORKSPACE: ctx.workspaceDir }, maxBuffer: 16 * 1024 * 1024,
    })
  } catch (error) {
    ctx.signal?.throwIfAborted()
    ctx.log(`用例命令退出非零：${(error as Error).message.slice(0, 300)}`)
  }
  const result = await summary(ctx)
  const expected = await cases(ctx)
  if (!result.cases.length || new Set(result.cases.map((test) => test.id)).size !== result.cases.length
    || expected.some((test) => !result.cases.some((row) => row.id === test.id))) {
    return { status: 'blocked' as const, message: '用例汇总缺失、重复或未覆盖冻结用例' }
  }
  const failures = result.cases.filter((test) => test.status !== 'passed' && !awaitingHuman(test.status))
  const pending = result.cases.filter((test) => awaitingHuman(test.status))
  return { data: { total: result.cases.length, failures: failures.map((test) => ({ subject: test.id, status: test.status, evidence: test.evidence })), pending: pending.map((test) => ({ subject: test.id, status: test.status })) } }
}
/** 修复代码从集成分支开 worktree：任务代码只在集成分支里会合 */
export function integratedBranch(ctx: NodeContext): string | undefined {
  return (ctx.resultOf('integration') as { branch?: string } | undefined)?.branch
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
export async function qualityReport(ctx: NodeContext) {
  const tests = await cases(ctx)
  const result = await summary(ctx)
  const acs = [...new Set(((await ctx.readArtifact('spec/prd.md')) ?? '').match(acId) ?? [])]
  const rows = acs.map((ac) => {
    const related = tests.filter((test) => test.covers.includes(ac))
    const passed = related.filter((test) => result.cases.some((row) => row.id === test.id && row.status === 'passed')).length
    return `| ${ac} | ${related.length} | ${passed} | ${related.length - passed} |`
  })
  const pending = result.cases.filter((test) => awaitingHuman(test.status))
  const waiting = pending.length ? [`待人工 ${pending.length} 条（人工执行或等裁决，准出时逐条确认）：${pending.map((test) => `${test.id}（${test.status}）`).join('、')}`, ''] : []
  await put(ctx, 'reports/quality.md', ['# 质量报告', '', `用例 ${tests.length} 条，通过 ${result.cases.filter((test) => test.status === 'passed').length} 条。`, '', ...waiting, '| AC | 用例 | 通过 | 未通过 |', '|---|---|---|---|', ...rows].join('\n'))
}
