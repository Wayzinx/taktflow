/**
 * 节点的"目标 / 负责人 / 完成标准 / 小结"（docs/design/19 §2、§7），对齐 templates/workflows/sdlc.workflow.ts。
 * 展开节点（implement/<key>/code|review）和 Loop 体内节点按后缀匹配。
 */
import type { CompletionCheck } from '@taktflow/core'
import type { MockRun, TplNode } from './mock-data'

interface Meta {
  goal: string
  owner?: string
  completion?: string[]
  summary?: string
}

const META: Record<string, Meta> = {
  clarify: { goal: '列出会影响实现或验收的待确认问题', owner: 'pm', completion: ['每个问题都标明影响的 AC 或模块', '不重复 PRD 已写明的内容'], summary: '整理出待确认问题，已写入 spec/clarify.md' },
  'answer-clarify': { goal: '由需求负责人逐条答复澄清问题', owner: 'pm' },
  spec: { goal: '把物料与澄清结论写成可验证的 spec', owner: 'pm', completion: ['每条 AC 都有输入与期望输出', 'AC 编号从 AC-1 连续编号', '范围外事项单列'], summary: 'AC 全部可验证，范围外事项已单列' },
  'review-spec': { goal: '确认 spec 的范围与验收标准', owner: 'pm' },
  design: { goal: '给出改动范围、方案与可执行的契约', owner: 'arch', completion: ['覆盖全部 AC', '契约写明错误码与边界输入', '写明回滚方案'], summary: '方案与契约已写入 design/' },
  'design-gate': { goal: '系分质量评分不低于 80', owner: 'arch' },
  'review-design': { goal: '交叉评审方案与契约，可冻结后进入测分', owner: 'arch' },
  'test-design': { goal: '每条 AC 至少一条可断言的用例', owner: 'qa', completion: ['每条 AC 至少一条用例', '每条用例写明断言', '不依赖实现细节'], summary: '用例覆盖全部 AC，断言明确' },
  'review-cases': { goal: '确认用例覆盖与断言有效', owner: 'qa' },
  'trace-gate': { goal: 'AC ↔ 用例双向映射无缺口', owner: 'qa' },
  freeze: { goal: '冻结 spec / 契约 / 用例基线' },
  implement: { goal: '按系分拆分开发任务并逐个实现', owner: 'arch', summary: '拆成开发任务，按依赖串行实现' },
  automate: { goal: '把用例转成可执行脚本，不弱化断言', owner: 'qa', completion: ['每条用例对应一个脚本', '断言与用例一致'], summary: '用例全部转为可执行脚本' },
  'dev-test-loop': { goal: '用例全部通过或交人裁决', owner: 'rd' },
  'run-cases': { goal: '执行全部用例并留存证据', owner: 'qa' },
  judge: { goal: '对失败用例逐条归因并路由', owner: 'qa', summary: '失败逐条归因，已路由到修复节点' },
  'fix-code': { goal: '按判决修复产品代码，不改测试', owner: 'rd', completion: ['判决里的每个 product_bug 都有对应修改', '本地单测通过'], summary: '按判决修复，已回到执行用例' },
  'fix-script': { goal: '只修脚本的机械问题', owner: 'qa' },
  'fix-case': { goal: '按 spec 修正用例并写明依据', owner: 'qa' },
  impact: { goal: '评估改动的影响面与回归范围', owner: 'rd', completion: ['列出受影响的调用方', '给出回归建议'], summary: '影响面限于改动模块，已给回归建议' },
  'quality-report': { goal: '汇总 AC 覆盖与执行结果', owner: 'qa' },
  acceptance: { goal: '需求负责人确认准出', owner: 'pm' },
  'knowledge-writeback': { goal: '把业务规则与踩坑沉淀到知识库', owner: 'pm', summary: '沉淀 2 条业务规则、1 条踩坑' },
}

function metaOf(t: TplNode): Meta | undefined {
  const hit = META[t.id] ?? META[t.id.split('/').pop()!]
  if (hit) return hit
  if (t.id.endsWith('/code')) return { goal: `${t.title.replace(/^实现：/, '')}：代码与单测`, owner: 'rd', completion: ['只改任务写权限内的文件', '新增或修改的逻辑都有单测', '本地单测全部通过'], summary: '改动与单测已提交到 worktree' }
  if (t.id.endsWith('/review')) return { goal: `评审 ${t.title.replace(/^(评审|代码评审)：/, '')} 的正确性与边界`, owner: 'rd', summary: '评审 1 轮通过' }
  return undefined
}

/** 给运行的模板、图节点、节点状态补上目标 / 负责人 / 完成标准 / 小结；完成标准自检只给已成功的节点。 */
export function applyNodeMeta(run: MockRun): void {
  for (const t of run.tpl.values()) {
    const m = metaOf(t)
    if (!m) continue
    t.goal ??= m.goal
    t.owner ??= m.owner
    if (t.kind === 'agent') t.completion ??= m.completion
    const g = run.graph.nodes.find((n) => n.id === t.id)
    const st = run.state.nodes[t.id]
    if (g) g.goal ??= t.goal
    if (!st || st.status !== 'succeeded') continue
    st.summary ??= m.summary
    if (g) g.summary ??= st.summary
    if (t.completion && !st.checks && run.state.runId === 'run-20261104-0004' && t.id === 'design') {
      // REQ-004 系分：自检一条未满足、一条声称满足但没给证据（门禁随后按 rubric 拦下）
      st.checks = [
        { id: 'c1', criterion: t.completion[0]!, pass: true, evidence: 'design/design.md@v1 §方案' },
        { id: 'c2', criterion: t.completion[1]!, pass: false, evidence: 'design/design.md 的"待补充"里仍列着错误码定义' },
        { id: 'c3', criterion: t.completion[2]!, pass: true },
      ]
      continue
    }
    if (t.completion && !st.checks) st.checks = passChecks(t.completion, st.outputs.map((o) => `${o.path}@v${o.version ?? 1}`))
  }
}

export function passChecks(completion: string[], evidence: string[]): CompletionCheck[] {
  return completion.map((criterion, i) => ({ id: `c${i + 1}`, criterion, pass: true, evidence: evidence[i % Math.max(1, evidence.length)] ?? '本地单测通过（见 Trace）' }))
}

/** 职责标签 → 演示空间里的成员（与 mock-space.ts 的 duties 一致）。 */
export const DUTY_MEMBERS: Record<string, string[]> = { pm: ['wayne'], arch: ['lin'], rd: ['lin', 'chen'], qa: ['qiao'] }
