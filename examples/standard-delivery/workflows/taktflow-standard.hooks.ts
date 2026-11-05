import { execFile } from 'node:child_process'
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { agent, review, type JudgeVerdict, type NodeContext, type PlannedItem } from '@taktflow/core'

const execute = promisify(execFile)
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
    agent({ id: 'code', title: `实现：${item.title}`, role: item.role ?? 'dev', repo,
      inputs: [{ path: 'spec/prd.md' }, { path: 'design/**' }],
      outputs: [{ path: `tasks/${item.key}.md`, kind: 'task' }, { path: `tasks/${item.key}.diff`, kind: 'code-change' }],
      prompt: `实现任务 ${item.key}「${item.title}」，仓库 ${repo}。在 tasks/${item.key}.md 写改动说明与自测证据，并把本任务统一 diff 写到 tasks/${item.key}.diff。` }),
    review({ id: 'review-code', title: `代码评审：${item.title}`, needs: ['code'], target: { code: { repo } },
      author: { role: item.role ?? 'dev' }, reviewers: [{ role: 'reviewer', focus: '正确性、复用、风险；审查 diff 与契约' }],
      maxRounds: 3, humanSignoff: true, onExhausted: { rework: 'code', maxReworks: 1 } }),
  ]
}
export async function runCases(ctx: NodeContext) {
  const actual = await readFile(join(ctx.projectDir, String(ctx.args.testScript ?? 'tests/run-cases.mjs')), 'utf8')
  if (actual !== await ctx.readArtifact('scripts/run-cases.mjs')) return { status: 'blocked' as const, message: '实际执行脚本与评审产物不一致' }
  await rm(join(ctx.workspaceDir, 'evidence/summary.json'), { force: true })
  try {
    await execute('/bin/sh', ['-c', String(ctx.args.caseCommand ?? 'npm test')], {
      cwd: ctx.projectDir, signal: ctx.signal, env: { ...process.env, TAKT_WORKSPACE: ctx.workspaceDir }, maxBuffer: 16 * 1024 * 1024,
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
  return { data: { total: result.cases.length, failures: result.cases.filter((test) => test.status !== 'passed').map((test) => ({ subject: test.id, status: test.status, evidence: test.evidence })) } }
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
  await put(ctx, 'reports/quality.md', ['# 质量报告', '', `用例 ${tests.length} 条，通过 ${result.cases.filter((test) => test.status === 'passed').length} 条。`, '', '| AC | 用例 | 通过 | 未通过 |', '|---|---|---|---|', ...rows].join('\n'))
}
