/**
 * workflow 编辑器演示数据：hello-delivery 空间的三个 workflow。
 * - sdlc：与 examples/standard-delivery 的标准流水线一致，可编辑（含 loop、planner、review 和代码值）；
 * - task：Lead 派发临时任务用的小 workflow，可编辑；
 * - hotfix：nodes 由函数生成，不满足受限子集，画布只读。
 */
import type { EditableNode, EditableValue, EditableWorkflow, NodeKind, WorkflowDiagnostic } from '@taktflow/core'
import { code, lit } from './workflow-edit'

class Code {
  constructor(readonly text: string) {}
}
const c = (text: string) => new Code(text)
const val = (v: unknown): EditableValue => (v instanceof Code ? code(v.text) : lit(v))

function n(kind: NodeKind, props: Record<string, unknown>, body?: EditableNode[]): EditableNode {
  const out: Record<string, EditableValue> = {}
  for (const [k, v] of Object.entries(props)) out[k] = val(v)
  return { id: props.id as string, kind, props: out, body }
}

const STAGES = [
  { id: 'understand', title: '需求理解' }, { id: 'design', title: '系分设计' },
  { id: 'test-design', title: '测分设计' }, { id: 'align', title: '对齐冻结' },
  { id: 'develop', title: '研发' }, { id: 'automate', title: '用例转自动化' },
  { id: 'loop', title: '研发测试 Loop' }, { id: 'impact', title: '影响面评估' }, { id: 'report', title: '准出' },
]

const rework = (target: string) => ({ maxRounds: 3, humanSignoff: true, onExhausted: { rework: target, maxReworks: 1 } })

const SDLC_NODES: EditableNode[] = [
  n('agent', { id: 'clarify', title: '需求澄清', stage: 'understand', role: 'pm', inputs: [{ path: 'inputs/**' }], outputs: [{ path: 'spec/clarify.md', kind: 'clarification' }], prompt: '阅读原始物料，列出待确认问题及依据。信息完整时明确写无待确认问题。' }),
  n('human', { id: 'answer-clarify', title: '回答澄清', stage: 'understand', needs: ['clarify'], form: 'answer', ask: '请回答 spec/clarify.md 中的问题。' }),
  n('agent', { id: 'prd', title: '编写 PRD', stage: 'understand', role: 'pm', needs: ['answer-clarify'], inputs: [{ path: 'inputs/**' }, { path: 'spec/clarify.md' }], outputs: [{ path: 'spec/prd.md', kind: 'spec' }], prompt: '编写 spec/prd.md：背景、范围、约束、可验证的验收标准 AC-<n>。纳入澄清结论。' }),
  n('review', { id: 'review-prd', title: 'PRD 交叉评审', stage: 'understand', needs: ['prd'], target: ['spec/prd.md'], author: { role: 'pm' }, reviewers: [{ role: 'architect', focus: '研发视角：可实现性、接口与数据影响' }, { role: 'test-designer', focus: '可测性、验收标准' }], ...rework('prd') }),
  n('agent', { id: 'design', title: '系分与接口契约', stage: 'design', role: 'architect', needs: ['review-prd'], inputs: [{ path: 'spec/prd.md' }], outputs: [{ path: 'design/design.md', kind: 'design' }, { path: 'design/contracts.json', kind: 'contract' }], prompt: '设计改动范围、接口字段、错误码、数据影响、复用与回滚。分别写 design/design.md 和 design/contracts.json。' }),
  n('review', { id: 'review-design', title: '系分交叉评审', stage: 'design', needs: ['design'], target: ['design/**'], author: { role: 'architect' }, reviewers: [{ role: 'pm', focus: '需求完整性' }, { role: 'test-designer', focus: '契约可验证性' }, { role: 'reviewer', focus: '架构视角：模块边界、复用、风险与回滚' }], ...rework('design') }),
  n('agent', { id: 'test-design', title: '测分与用例', stage: 'test-design', role: 'test-designer', needs: ['review-design'], inputs: [{ path: 'spec/prd.md' }, { path: 'design/contracts.json' }], outputs: [{ path: 'test-plan/plan.md', kind: 'test-plan' }, { path: 'cases/*.json', kind: 'case' }], prompt: '只根据 PRD 和接口契约设计黑盒测试，不读产品代码。写测分和 cases/<CaseID>.json，每条用例含 id、covers: [AC-<n>]、步骤与业务断言。' }),
  n('review', { id: 'review-cases', title: '测分交叉评审', stage: 'test-design', needs: ['test-design'], target: ['test-plan/**', 'cases/*.json'], author: { role: 'test-designer' }, reviewers: [{ role: 'pm', focus: '需求覆盖' }, { role: 'architect', focus: '契约与边界' }], ...rework('test-design') }),
  n('gate', { id: 'trace-gate', title: '追溯对齐', stage: 'align', needs: ['review-cases'], checks: c("[{ id: 'ac-covered', kind: 'function', fn: traceCoverage }]") }),
  n('script', { id: 'freeze', title: '冻结基线', stage: 'align', needs: ['trace-gate'], run: c('freezeBaseline'), outputs: [{ path: 'decisions/baseline.json', kind: 'decision' }] }),
  n('planner', { id: 'implement', title: '拆任务、实现与代码评审', stage: 'develop', needs: ['freeze'], role: 'architect', maxItems: 12, allowedRoles: ['dev'], inputs: [{ path: 'spec/prd.md' }, { path: 'design/**' }], prompt: '将实现拆为有边界的任务，给出 key、title、dependsOn、role=dev、params.repo（默认 app）。', expand: c('expandTask') }),
  n('agent', { id: 'automate', title: '实现自动化脚本', stage: 'automate', needs: ['freeze'], role: 'automation', inputs: [{ path: 'cases/*.json' }, { path: 'design/contracts.json' }], outputs: [{ path: 'scripts/run-cases.mjs', kind: 'script' }], prompt: '实现 tests/run-cases.mjs，逐条运行用例，验证业务结果；将每条证据和 evidence/summary.json 写入公共存放区。将待评审脚本副本写到 scripts/run-cases.mjs。' }),
  n('review', { id: 'review-scripts', title: '脚本评审', stage: 'automate', needs: ['automate'], target: ['scripts/**'], author: { role: 'automation', prompt: '同时更新公共存放区 scripts/ 副本与项目 tests/ 下实际执行的脚本，保持一致。' }, reviewers: [{ role: 'test-designer', focus: '断言有效性、覆盖完整性；禁止弱化断言' }], ...rework('automate') }),
  n('script', { id: 'integration', title: '集成任务分支', stage: 'develop', needs: ['implement'], run: c('integrate'), outputs: [{ path: 'tasks/integration.json', kind: 'code-change' }] }),
  n('loop', { id: 'dev-test-loop', title: '研发测试 Loop', stage: 'loop', needs: ['integration', 'review-scripts'], maxIterations: 5, onExhausted: 'human', until: c('converged') }, [
    n('script', { id: 'run-cases', title: '执行用例', run: c('runCases'), outputs: [{ path: 'evidence/**', kind: 'evidence' }] }),
    n('judge', { id: 'judge', title: '失败判决', role: 'judge', needs: ['run-cases'], target: 'run-cases', routes: { product_bug: 'fix-code', script_defect: 'fix-script', case_defect: 'fix-case', flaky: 'ignore', env_issue: 'human', requirement_gap: 'human', unknown: 'human' } }),
    n('agent', { id: 'fix-code', title: '修复产品代码', role: 'dev', repo: 'app', needs: ['judge'], inputs: [{ path: 'evidence/**' }, { path: 'reports/verdicts/**' }], outputs: [{ path: 'tasks/repair.diff', kind: 'code-change' }], prompt: c("repairPrompt('fix-code', '按证据修复产品代码，禁止改用例与测试。将修复 diff 写入 tasks/repair.diff。')") }),
    n('review', { id: 'review-fix', title: '修复代码评审', needs: ['fix-code'], when: c('codeWasFixed'), target: { code: { repo: 'app' } }, author: { role: 'dev' }, reviewers: [{ role: 'reviewer', focus: '修复有效性、无弱化测试' }], ...rework('fix-code') }),
    n('script', { id: 'integrate-fix', title: '集成评审后的修复', needs: ['review-fix'], when: c('codeWasFixed'), run: c('integrate'), outputs: [{ path: 'tasks/integration.json', kind: 'code-change' }] }),
    n('agent', { id: 'fix-script', title: '修复脚本', role: 'automation', needs: ['judge'], inputs: [{ path: 'evidence/**' }, { path: 'reports/verdicts/**' }], prompt: c("repairPrompt('fix-script', '只修定位、等待与取值问题，禁止弱化断言。')") }),
    n('agent', { id: 'fix-case', title: '修正用例', role: 'test-designer', needs: ['judge'], inputs: [{ path: 'spec/prd.md' }, { path: 'reports/verdicts/**' }], prompt: c("repairPrompt('fix-case', '按需求依据修正用例，记录原因；语义修改须经人工确认。')") }),
  ]),
  n('agent', { id: 'impact', title: '影响面评估', stage: 'impact', needs: ['dev-test-loop'], role: 'reviewer', inputs: [{ path: 'tasks/**' }, { path: 'evidence/**' }], outputs: [{ path: 'reports/impact.md', kind: 'report' }], prompt: '评估改动影响，列回归范围与未覆盖风险。' }),
  n('script', { id: 'quality-report', title: '质量报告', stage: 'report', needs: ['impact'], run: c('qualityReport'), outputs: [{ path: 'reports/quality.md', kind: 'report' }] }),
  n('human', { id: 'acceptance', title: '人工准出', stage: 'report', needs: ['quality-report'], form: 'approve', ask: '审阅质量报告、影响面与评审记录，是否准出？' }),
  n('agent', { id: 'knowledge-writeback', title: '知识回流', stage: 'report', needs: ['acceptance'], role: 'pm', inputs: [{ path: 'reports/**' }, { path: 'decisions/**' }], outputs: [{ path: 'reports/knowledge-diff.md', kind: 'knowledge' }], prompt: '整理业务规则、决策与问题教训，写成知识库修改建议供人合入。' }),
]

export interface WorkflowSeed {
  file: string
  model: EditableWorkflow
  /** 源码开头的注释与 import（打印时原样保留）。 */
  preamble: string
  /** 不可编辑时直接用这份源码，不经打印器。 */
  source?: string
  diagnostics?: WorkflowDiagnostic[]
  /** 首个修订的作者与时间（分钟前）。 */
  ageMin: number
  runs: number
}

const HOOKS_IMPORT = `/**
 * 标准交付流水线。默认 3 轮评审、1 次打回、人工确认。
 */
import { agent, defineWorkflow, gate, human, judge, loop, planner, review, script } from '@taktflow/core'
import { integrate } from './sdlc.integration.js'
import { codeWasFixed, converged, expandTask, freezeBaseline, qualityReport, repairPrompt, runCases, traceCoverage } from './sdlc.hooks.js'`

const HOTFIX_SOURCE = `/** 线上热修：步骤表驱动，节点由函数生成。 */
import { agent, defineWorkflow, human, review } from '@taktflow/core'
import { steps } from './hotfix.steps.js'

export default defineWorkflow({
  id: 'hotfix',
  title: '线上热修',
  version: '0.1.0',
  stages: [{ id: 'fix', title: '修复' }, { id: 'release', title: '发布' }],
  nodes: [
    ...steps.map((s, i) => agent({ id: s.id, title: s.title, stage: 'fix', role: 'dev', needs: i ? [steps[i - 1].id] : [] })),
    review({ id: 'review-hotfix', title: '热修评审', stage: 'release', needs: [steps.at(-1).id], target: { code: { repo: 'app' } }, author: { role: 'dev' }, reviewers: [{ role: 'reviewer' }], maxRounds: 2, onExhausted: 'human' }),
    human({ id: 'release', title: '确认发布', stage: 'release', needs: ['review-hotfix'], form: 'approve', ask: '热修已评审，是否发布？' }),
  ],
})
`

export function workflowSeeds(): Record<string, WorkflowSeed> {
  return {
    sdlc: {
      file: 'workflows/sdlc.workflow.ts',
      preamble: HOOKS_IMPORT,
      ageMin: 26 * 60,
      runs: 6,
      model: { meta: { id: 'sdlc', title: lit('标准交付流水线'), description: lit('需求理解 → 系分 → 测分 → 研发 → 测试 Loop → 准出，每个产出都经交叉评审'), version: lit('0.2.0') }, stages: lit(STAGES), nodes: structuredClone(SDLC_NODES), editable: true },
    },
    task: {
      file: 'workflows/task.workflow.ts',
      preamble: '/** Lead 派发的临时任务：实现 → 评审。args.title / args.prompt 由 Lead 填写。 */',
      ageMin: 3 * 24 * 60,
      runs: 3,
      model: {
        meta: { id: 'task', title: lit('临时任务（实现 → 评审）'), version: lit('0.1.0') },
        stages: lit([{ id: 'task', title: '临时任务' }]),
        nodes: [
          n('agent', { id: 'implement', title: c('args.title'), stage: 'task', role: c('args.role ?? \'dev\''), prompt: c('args.prompt') }),
          n('review', { id: 'review', title: '评审', stage: 'task', needs: ['implement'], target: { code: { repo: 'app' } }, author: { role: 'dev' }, reviewers: [{ role: 'reviewer' }], maxRounds: 2, onExhausted: 'human' }),
        ],
        editable: true,
      },
    },
    hotfix: {
      file: 'workflows/hotfix.workflow.ts',
      preamble: '',
      source: HOTFIX_SOURCE,
      ageMin: 9 * 24 * 60,
      runs: 0,
      diagnostics: [{ severity: 'warning', message: 'nodes 不是纯数组字面量（第 11 行用 steps.map(...) 生成节点），不满足可视化编辑的受限子集，画布只读。改成逐个列出节点后即可在画布上编辑。', line: 11, column: 5 }],
      model: {
        meta: { id: 'hotfix', title: lit('线上热修'), version: lit('0.1.0') },
        stages: lit([{ id: 'fix', title: '修复' }, { id: 'release', title: '发布' }]),
        nodes: [
          n('review', { id: 'review-hotfix', title: '热修评审', stage: 'release', target: { code: { repo: 'app' } }, author: { role: 'dev' }, reviewers: [{ role: 'reviewer' }], maxRounds: 2, onExhausted: 'human' }),
          n('human', { id: 'release', title: '确认发布', stage: 'release', needs: ['review-hotfix'], form: 'approve', ask: '热修已评审，是否发布？' }),
        ],
        editable: false,
      },
    },
  }
}
