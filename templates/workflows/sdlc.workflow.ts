/**
 * 默认交付流水线：需求理解 → 系分 → 测分 → 对齐冻结 → 研发测试 Loop → 影响面 → 质量报告。
 *
 * 来源：browser-nav-sdlc 原型的 7 个阶段；默认保留需求、系分、用例三处人工评审。
 * 约定：
 * - 产物路径都相对需求的公共存放区（.takt/workspaces/<REQ>/）；
 * - 用例文件 cases/<CaseID>.json 至少包含 { id, title, covers: ["AC-1", ...] }；
 * - 用例执行器把结果写到 evidence/summary.json：{ cases: [{ id, status: "passed" | "failed" | "error", evidence?: string }] }。
 *
 * 运行参数（takt run sdlc --req REQ-001 --arg key=value）：
 * - caseCommand：执行全部用例的命令（默认 `npm test`），必须产出 evidence/summary.json；
 * - maxLoop：研发测试 Loop 最大轮次（默认 5）。
 */
import { execFile } from 'node:child_process'
import { readdir, writeFile, mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { agent, defineWorkflow, gate, human, judge, loop, planner, script, type NodeContext, type JudgeVerdict } from '@taktflow/core'

const execute = promisify(execFile)

const AC_ID = /\bAC-\d+(?:-\d+)?\b/g

interface CaseFile {
  id: string
  title?: string
  covers?: string[]
}

interface CaseSummary {
  cases: Array<{ id: string; status: 'passed' | 'failed' | 'error'; evidence?: string }>
}

async function readCases(ctx: NodeContext): Promise<CaseFile[]> {
  const dir = join(ctx.workspaceDir, 'cases')
  const files = (await readdir(dir).catch(() => [])).filter((f) => f.endsWith('.json'))
  const cases: CaseFile[] = []
  for (const f of files) {
    const text = await ctx.readArtifact(`cases/${f}`)
    if (text) cases.push(JSON.parse(text) as CaseFile)
  }
  return cases
}

async function readSummary(ctx: NodeContext): Promise<CaseSummary> {
  const text = await ctx.readArtifact('evidence/summary.json')
  return text ? (JSON.parse(text) as CaseSummary) : { cases: [] }
}

/** 执行全部用例并把失败列表交给判决节点。COMPLETED ≠ PASS：只认 summary 里的用例结论。 */
async function runCases(ctx: NodeContext) {
  const command = String(ctx.args.caseCommand ?? 'npm test')
  await rm(join(ctx.workspaceDir, 'evidence/summary.json'), { force: true })
  try {
    await execute('/bin/sh', ['-c', command], { cwd: ctx.projectDir, env: { ...process.env, TAKT_WORKSPACE: ctx.workspaceDir }, maxBuffer: 16 * 1024 * 1024 })
  } catch (err) {
    ctx.log(`用例命令退出码非 0（失败用例会在 summary 里体现）：${(err as Error).message.slice(0, 300)}`)
  }
  const summary = await readSummary(ctx)
  if (summary.cases.length === 0) return { status: 'blocked' as const, message: 'evidence/summary.json 为空：用例执行器没有产出结论' }
  const failures = summary.cases.filter((c) => c.status !== 'passed').map((c) => ({ subject: c.id, status: c.status, evidence: c.evidence }))
  return { data: { failures, total: summary.cases.length } }
}

function repairPrompt(target: string, instruction: string) {
  return (ctx: NodeContext): string => {
    const result = ctx.resultOf('judge') as { verdicts?: JudgeVerdict[]; routed?: Record<string, string[]> } | undefined
    const subjects = result?.routed?.[target] ?? []
    const verdicts = (result?.verdicts ?? []).filter((verdict) => subjects.includes(verdict.subject))
    return `${instruction}\n本轮路由给 ${target} 的对象与判决（含证据路径、原因和修复提示）：\n${JSON.stringify({ subjects, verdicts }, null, 2)}`
  }
}

const repairInputs = [{ path: 'reports/verdicts/**', required: false }, { path: 'evidence/**', required: false }]

export default defineWorkflow({
  id: 'sdlc',
  title: '标准交付流水线',
  description: '需求理解 → 系分 → 测分 → 对齐冻结 → 研发测试 Loop → 影响面 → 质量报告',
  version: '0.1.0',
  stages: [
    { id: 'understand', title: '需求理解' },
    { id: 'design', title: '系分设计' },
    { id: 'test-design', title: '测分设计' },
    { id: 'align', title: '对齐冻结' },
    { id: 'loop', title: '研发测试 Loop' },
    { id: 'impact', title: '影响面评估' },
    { id: 'report', title: '质量报告' },
  ],
  nodes: [
    // ------------------------------------------------ 需求理解
    agent({
      id: 'clarify',
      title: '需求澄清',
      stage: 'understand',
      role: 'pm',
      inputs: [{ path: 'inputs/**' }, { path: 'decisions/**', required: false }],
      outputs: [{ path: 'spec/clarify.md', kind: 'clarification' }],
      prompt: '读 inputs/ 下的 PRD、会议纪要和设计稿，列出所有会影响实现或验收的待确认问题（每条写清楚为什么要问、可选答案）。信息足够就写"无待确认问题"。',
    }),
    human({ id: 'answer-clarify', title: '回答澄清问题', stage: 'understand', needs: ['clarify'], form: 'answer', ask: '请在 spec/clarify.md 里逐条回答，或在这里写下统一答复。' }),
    agent({
      id: 'spec',
      title: '编写 spec',
      stage: 'understand',
      role: 'pm',
      needs: ['answer-clarify'],
      inputs: [{ path: 'inputs/**' }, { path: 'spec/clarify.md' }, { path: 'decisions/**', required: false }],
      outputs: [{ path: 'spec/spec.md', kind: 'spec' }],
      prompt: '根据物料和澄清结论写 spec：背景、范围、不做什么、功能点、验收标准。每条验收标准编号为 AC-<n>，必须可验证（写清输入、操作、期望结果）。',
    }),
    human({ id: 'review-spec', title: '评审 spec', stage: 'understand', needs: ['spec'], form: 'approve', ask: '审阅 spec/spec.md：范围和验收标准是否正确、可验证？' }),

    // ------------------------------------------------ 系分设计
    agent({
      id: 'design',
      title: '系分设计',
      stage: 'design',
      role: 'architect',
      needs: ['review-spec'],
      inputs: [{ path: 'spec/spec.md' }],
      knowledge: [{ text: '与本需求相关的业务规则', intent: 'business' }, { text: '与本需求相关的现有模块、接口和数据表', intent: 'impact' }],
      outputs: [
        { path: 'design/design.md', kind: 'design' },
        { path: 'design/contracts.json', kind: 'contract' },
      ],
      prompt: '基于 spec 和现有代码写系分：改动范围、模块划分、接口契约（路径、方法、入参、响应结构、错误码）、数据变更、风险。契约写进 design/contracts.json。存量能力优先复用，不要重写。',
    }),
    gate({
      id: 'design-gate',
      title: '系分门禁',
      stage: 'design',
      needs: ['design'],
      onFail: 'human',
      checks: [{ id: 'design-rubric', kind: 'rubric', role: 'reviewer', threshold: 80, rubric: '覆盖 spec 全部 AC；契约字段完整可执行；复用存量能力；风险与回滚方案明确。' }],
    }),
    human({ id: 'review-design', title: '评审系分', stage: 'design', needs: ['design-gate'], form: 'approve', ask: '审阅 design/：方案和契约是否可以冻结？' }),

    // ------------------------------------------------ 测分设计（黑盒：不看代码）
    agent({
      id: 'test-design',
      title: '测分与用例设计',
      stage: 'test-design',
      role: 'test-designer',
      needs: ['review-design'],
      inputs: [{ path: 'spec/spec.md' }, { path: 'design/contracts.json' }],
      outputs: [
        { path: 'test-plan/plan.md', kind: 'test-plan' },
        { path: 'cases/*.json', kind: 'case' },
      ],
      prompt: '按 spec 和契约设计测试：先写 test-plan/plan.md（范围、分层、数据构造、不可自动化项），再为每条用例写 cases/<CaseID>.json（id、title、covers 映射到 AC、前置、步骤、断言必须落到业务字段或终态）。不要读产品代码。',
    }),
    human({ id: 'review-cases', title: '评审用例', stage: 'test-design', needs: ['test-design'], form: 'approve', ask: '审阅 test-plan/ 和 cases/：用例是否覆盖全部验收标准、断言是否有效？' }),

    // ------------------------------------------------ 对齐冻结
    gate({
      id: 'trace-gate',
      title: '追溯对齐',
      stage: 'align',
      needs: ['review-cases'],
      checks: [
        {
          id: 'ac-covered',
          kind: 'function',
          title: '每条 AC 至少有一条用例，每条用例都映射到 AC',
          fn: async (ctx) => {
            const spec = (await ctx.readArtifact('spec/spec.md')) ?? ''
            const acs = new Set(spec.match(AC_ID) ?? [])
            const cases = await readCases(ctx)
            const covered = new Set(cases.flatMap((c) => c.covers ?? []))
            const uncovered = [...acs].filter((ac) => !covered.has(ac))
            const orphan = cases.filter((c) => !(c.covers ?? []).some((ac) => acs.has(ac))).map((c) => c.id)
            return { id: 'ac-covered', pass: acs.size > 0 && uncovered.length === 0 && orphan.length === 0, details: { uncovered, orphan }, message: `AC ${acs.size} 条，未覆盖 ${uncovered.length}，孤立用例 ${orphan.length}` }
          },
        },
      ],
    }),
    script({
      id: 'freeze',
      title: '冻结基线',
      stage: 'align',
      needs: ['trace-gate'],
      outputs: [{ path: 'decisions/baseline.json', kind: 'decision' }],
      run: async (ctx) => {
        const cases = await readCases(ctx)
        await mkdir(join(ctx.workspaceDir, 'decisions'), { recursive: true })
        await writeFile(join(ctx.workspaceDir, 'decisions/baseline.json'), JSON.stringify({ frozenAt: new Date().toISOString(), runId: ctx.runId, cases: cases.map((c) => c.id) }, null, 2))
        return { data: { cases: cases.length } }
      },
    }),

    // ------------------------------------------------ 研发测试 Loop
    planner({
      id: 'implement',
      title: '拆分并实现开发任务',
      stage: 'loop',
      role: 'architect',
      needs: ['freeze'],
      maxItems: 12,
      allowedRoles: ['dev'],
      prompt: '读 spec/spec.md 和 design/，把实现拆成可独立交付的任务（每个任务半天内能完成），给出 key、title、dependsOn 和 role。',
      expand: (item) => [
        agent({ id: 'code', title: `实现：${item.title}`, role: item.role ?? 'dev', inputs: [{ path: 'spec/spec.md' }, { path: 'design/**' }], outputs: [{ path: `tasks/${item.key}.md`, kind: 'task' }], prompt: `实现任务 ${item.key}「${item.title}」。完成后在 tasks/${item.key}.md 写改动摘要和自测结果。` }),
        agent({ id: 'review', title: `评审：${item.title}`, role: 'reviewer', needs: ['code'], inputs: [{ path: `tasks/${item.key}.md` }], outputs: [{ path: `reports/review-${item.key}.md`, kind: 'review' }], prompt: `评审任务 ${item.key} 的代码改动：正确性、冗余、可读性、是否复用存量能力。只写评审意见，不改代码。` }),
      ],
    }),
    agent({
      id: 'automate',
      title: '用例转自动化',
      stage: 'loop',
      role: 'automation',
      needs: ['freeze'],
      inputs: [{ path: 'cases/*.json' }, { path: 'design/contracts.json' }],
      prompt: '把 cases/ 下每条用例实现为一个自动化脚本（一条用例一个脚本），执行后写证据到 evidence/<CaseID>/，汇总到 evidence/summary.json。断言必须对应用例里的验证点，禁止只断言状态码。',
    }),
    loop({
      id: 'dev-test-loop',
      title: '研发测试 Loop',
      stage: 'loop',
      needs: ['implement', 'automate'],
      maxIterations: 5,
      onExhausted: 'human',
      until: (ctx) => {
        const r = ctx.resultOf('run-cases') as { failures?: unknown[] } | undefined
        return Array.isArray(r?.failures) && r.failures.length === 0
      },
      body: [
        script({ id: 'run-cases', title: '执行用例', run: runCases, outputs: [{ path: 'evidence/summary.json', kind: 'evidence' }, { path: 'evidence/**', kind: 'evidence' }] }),
        judge({
          id: 'judge',
          title: '失败判决',
          role: 'judge',
          needs: ['run-cases'],
          target: 'run-cases',
          routes: { product_bug: 'fix-code', script_defect: 'fix-script', case_defect: 'fix-case', env_issue: 'human', requirement_gap: 'human', unknown: 'human', flaky: 'ignore' },
        }),
        agent({ id: 'fix-code', title: '修复代码', role: 'dev', needs: ['judge'], inputs: repairInputs, prompt: repairPrompt('fix-code', '按判决和对应证据修复产品代码。不要修改测试和用例。') }),
        agent({ id: 'fix-script', title: '修复脚本', role: 'automation', needs: ['judge'], inputs: repairInputs, prompt: repairPrompt('fix-script', '只修定位、等待、取值等机械问题；不得删除或弱化断言。') }),
        agent({ id: 'fix-case', title: '修正用例', role: 'test-designer', needs: ['judge'], inputs: [{ path: 'spec/spec.md' }, ...repairInputs], outputs: [{ path: 'decisions/case-changes.md', kind: 'decision', required: false }], prompt: repairPrompt('fix-case', '按 spec 修正用例，并在 decisions/case-changes.md 写明每处修改的依据。') }),
      ],
    }),

    // ------------------------------------------------ 影响面评估
    agent({
      id: 'impact',
      title: '影响面评估',
      stage: 'impact',
      role: 'reviewer',
      needs: ['dev-test-loop'],
      knowledge: [{ text: '本次改动涉及的调用方和下游', intent: 'impact' }],
      outputs: [{ path: 'reports/impact.md', kind: 'report' }],
      prompt: '根据本需求的代码改动和调用链，列出可能受影响的存量功能、需要回归的范围和建议补测项。',
    }),

    // ------------------------------------------------ 质量报告
    script({
      id: 'quality-report',
      title: '生成质量报告',
      stage: 'report',
      needs: ['impact'],
      outputs: [{ path: 'reports/quality.md', kind: 'report' }],
      run: async (ctx) => {
        const spec = (await ctx.readArtifact('spec/spec.md')) ?? ''
        const acs = [...new Set(spec.match(AC_ID) ?? [])]
        const cases = await readCases(ctx)
        const summary = await readSummary(ctx)
        const status = new Map(summary.cases.map((c) => [c.id, c.status]))
        const rows = acs.map((ac) => {
          const related = cases.filter((c) => c.covers?.includes(ac))
          const passed = related.filter((c) => status.get(c.id) === 'passed').length
          return `| ${ac} | ${related.length} | ${passed} | ${related.length - passed} |`
        })
        const passedTotal = summary.cases.filter((c) => c.status === 'passed').length
        const body = [
          '# 质量报告',
          '',
          `用例 ${summary.cases.length} 条，通过 ${passedTotal} 条。`,
          '',
          '## 验收标准覆盖',
          '',
          '| AC | 用例 | 通过 | 未通过 |',
          '|---|---|---|---|',
          ...rows,
        ].join('\n')
        await mkdir(join(ctx.workspaceDir, 'reports'), { recursive: true })
        await writeFile(join(ctx.workspaceDir, 'reports/quality.md'), body)
      },
    }),
    human({ id: 'acceptance', title: '准出验收', stage: 'report', needs: ['quality-report'], form: 'approve', ask: '审阅 reports/quality.md 和 reports/impact.md，是否准出？' }),
    agent({
      id: 'knowledge-writeback',
      title: '知识回流',
      stage: 'report',
      role: 'pm',
      needs: ['acceptance'],
      inputs: [{ path: 'spec/spec.md' }, { path: 'decisions/**', required: false }, { path: 'reports/**' }],
      outputs: [{ path: 'reports/knowledge-diff.md', kind: 'knowledge' }],
      prompt: '把本需求沉淀的业务规则、决策和踩过的坑整理成知识库的修改建议（写成 diff 形式，供人审后合入）。',
    }),
  ],
})
