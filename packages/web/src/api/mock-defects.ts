import type { Actor, DefectAttribution, DefectConfirmRequest, DefectDetail, DefectReportRequest, EvalCase, EvalTarget } from '@taktflow/core'
import { WF } from './mock-eval-scorecards'

/**
 * 缺陷逃逸归因（docs/design/20 §3）：
 * - REQ-001 D-1 已确认：引入于 implement/greet-empty，漏检于 test-design（没有覆盖）与代码评审（看过没发现）；
 * - REQ-002 D-1 归因候选待确认：系分没写 CSV 转义约定，系分评审与测分都漏了。
 * 新录入的缺陷点"开始归因"后 1.8 秒出候选。
 */

const RUN1 = 'run-20261104-0001'
const RUN2 = 'run-20261104-0002'
const AUDITOR: Actor = { type: 'agent', role: 'auditor', harness: 'claude-code', model: 'claude-opus-4.1' }
const human = (id: string): Actor => ({ type: 'human', id })

const D1_REQ1: DefectDetail = {
  id: 'D-1', requirementId: 'REQ-001', title: '名字带首尾空格时问候语多出空格',
  description: '线上反馈：输入 " Ada " 时显示 "Hello,  Ada !"。spec AC-1 要求先去掉首尾空格再拼接问候语。',
  severity: 'minor', foundAt: '2026-11-05T02:20:00Z', reportedBy: human('qiao'), acs: ['AC-1'],
  links: [{ type: 'meego', url: 'https://meego.example.com/issue/4821', title: '#4821' }],
  evidence: ['feedback/4821.png', 'greet(" Ada ") → "Hello,  Ada !"'],
  status: 'confirmed',
  attribution: {
    defectId: 'D-1',
    introducedAt: { origin: 'implementation', runId: RUN1, nodeId: 'implement/greet-empty', artifact: { workspace: 'REQ-001', path: 'tasks/greet-empty.md', version: 1 }, evidence: ['src/greet.js:3 只在 trim 后为空时替换，非空分支直接用原值', 'tasks/greet-empty.md 写了"输出保留原值"'] },
    missedBy: [
      { runId: RUN1, nodeId: 'test-design', reason: 'not_covered', evidence: ['AC-1 只有 TC-GREET-001 一条用例，输入 "Ada"', 'test-plan/plan.md 的边界值没有列首尾空格'] },
      { runId: RUN1, nodeId: 'implement/greet-empty/review', reason: 'reviewed_but_missed', evidence: ['reports/review-greet-empty.md："输出保留原值"判为合理，与 AC-1 冲突'] },
    ],
    confidence: 0.82,
    suggestions: [
      { target: { kind: 'prompt', ref: 'sdlc/test-design' }, change: '每个字符串入参列出空串 / 纯空白 / 首尾空白 / 全角空白四类边界，并映射到 AC' },
      { target: { kind: 'review_focus', ref: 'implement/*/review' }, change: '代码评审侧重点加一条：输出格式逐条对照 spec 的 AC，而不是只看实现是否自洽' },
      { target: { kind: 'completion', ref: 'sdlc/implement' }, change: '完成标准加"字符串入参按 spec 规范化（trim）后再使用"' },
    ],
    precheck: { acCovered: true, cases: ['TC-GREET-001'], codeNodes: ['implement/greet-empty'], reviewedBy: ['implement/greet-empty/review'], gates: ['trace-gate'] },
    by: AUDITOR, at: '2026-11-05T02:31:00Z',
    confirmed: { by: human('wayne'), at: '2026-11-05T03:05:00Z', note: '同意。代码评审看过"保留原值"也算漏检，一并计入。', edited: true },
  },
}

const D1_REQ2: DefectDetail = {
  id: 'D-1', requirementId: 'REQ-002', title: '收货地址含逗号时 CSV 列错位',
  description: '灰度验收：地址 "朝阳区, 望京 SOHO" 的订单导出后，后面所有列右移一列，财务对账脚本报错。',
  severity: 'major', foundAt: '2026-11-05T07:48:00Z', reportedBy: human('chen'), acs: ['AC-2'],
  links: [{ type: 'feishu', url: 'https://feishu.example.com/docs/uat-export', title: 'UAT 记录' }],
  evidence: ['uat/export-1105.csv 第 37 行'],
  status: 'attributed',
  attribution: {
    defectId: 'D-1',
    introducedAt: { origin: 'design', runId: RUN2, nodeId: 'design', artifact: { workspace: 'REQ-002', path: 'design/design.md', version: 1 }, evidence: ['design/design.md 只写了"服务端流式写 CSV"，没有字段转义约定', '技能 csv-export 第 3 条规定了转义，但系分没有引用'] },
    missedBy: [
      { runId: RUN2, nodeId: 'review-design', reason: 'reviewed_but_missed', evidence: ['系分评审 3 轮意见里没有提到转义 / 引号'] },
      { runId: RUN2, nodeId: 'test-design', reason: 'not_covered', evidence: ['AC-2 的用例 TC-EXP-003 / 004 只覆盖金额精度与 BOM'] },
    ],
    confidence: 0.74,
    suggestions: [
      { target: { kind: 'review_focus', ref: 'review-design' }, change: '导出类需求评审时对照 csv-export 技能检查：BOM、分片、转义三项' },
      { target: { kind: 'skill', ref: 'csv-export' }, change: '在技能里加一节"系分必须写明的约定"，列出转义规则，供 architect 引用' },
      { target: { kind: 'gate_check', ref: 'design-gate' }, change: '系分门禁 rubric 增加"输出格式约定完整"一项' },
    ],
    precheck: { acCovered: true, cases: ['TC-EXP-003', 'TC-EXP-004'], codeNodes: ['implement'], reviewedBy: ['review-design'], gates: ['design-gate', 'trace-gate'] },
    by: AUDITOR, at: '2026-11-05T08:02:00Z',
  },
}

const nodeTarget = (nodeId: string): EvalTarget => ({ kind: 'node', workflowId: WF, nodeId: nodeId.replace(/\/.*$/, '') })

/** 确认后为引入节点与每个漏检节点生成回归用例（同一目标节点只生成一条）。 */
export function regressionCases(d: DefectDetail, at: string): EvalCase[] {
  const a = d.attribution
  if (!a) return []
  const nodes = [a.introducedAt.nodeId, ...a.missedBy.map((m) => m.nodeId)].filter((x): x is string => Boolean(x))
  const seen = new Set<string>()
  return nodes.flatMap((n) => {
    const t = nodeTarget(n)
    const key = t.kind === 'node' ? t.nodeId : ''
    if (seen.has(key)) return []
    seen.add(key)
    const introduced = n === a.introducedAt.nodeId
    return [{
      id: `EC-${d.requirementId}-${d.id}-${key}`,
      target: t,
      title: `回归：${d.title}（${introduced ? '不得引入' : '必须指出'}）`,
      source: { kind: 'defect', defectId: d.id, runId: a.introducedAt.runId ?? a.missedBy[0]?.runId, nodeId: n },
      node: { id: key, kind: 'agent', title: key, needs: [] },
      inputs: [{ path: 'spec/spec.md', content: '（冻结快照）', kind: 'spec' }],
      grading: introduced ? { mustNotIntroduce: [d.title] } : { mustFind: [d.title] },
      createdAt: at,
    } satisfies EvalCase]
  })
}

export interface MockDefects {
  list(reqId: string): DefectDetail[]
  report(reqId: string, body: DefectReportRequest): DefectDetail | string
  attribute(reqId: string, id: string, runId?: string): DefectDetail | string
  confirm(reqId: string, id: string, body: DefectConfirmRequest): { defect: DefectDetail; cases: EvalCase[] } | string
}

export function createMockDefects(seeded: boolean): MockDefects {
  const store = new Map<string, DefectDetail[]>(seeded ? [['REQ-001', [structuredClone(D1_REQ1)]], ['REQ-002', [structuredClone(D1_REQ2)]]] : [])
  const of = (reqId: string) => {
    let l = store.get(reqId)
    if (!l) store.set(reqId, (l = []))
    return l
  }
  return {
    list: (reqId) => [...of(reqId)].sort((a, b) => b.foundAt.localeCompare(a.foundAt)),
    report(reqId, body) {
      if (!body.title.trim()) return '标题必填'
      if (!body.description.trim()) return '描述必填'
      const l = of(reqId)
      const d: DefectDetail = { id: `D-${l.length + 1}`, requirementId: reqId, title: body.title.trim(), description: body.description.trim(), severity: body.severity, foundAt: new Date().toISOString(), reportedBy: human('web'), acs: body.acs, links: body.links, evidence: body.evidence, status: 'open' }
      l.push(d)
      return d
    },
    attribute(reqId, id, runId) {
      const d = of(reqId).find((x) => x.id === id)
      if (!d) return `缺陷 ${id} 不存在`
      if (d.status === 'confirmed') return '已确认的缺陷不能重新归因'
      d.attributing = true
      setTimeout(() => {
        const covered = Boolean(d.acs?.length) && !/AC-[4-9]/.test(d.acs!.join(','))
        const attribution: DefectAttribution = {
          defectId: d.id,
          introducedAt: { origin: 'implementation', runId, nodeId: 'implement', evidence: ['涉及代码由 implement 展开的任务提交（worktree 分支）'] },
          missedBy: [{ runId, nodeId: 'test-design', reason: covered ? 'wrong_assertion' : 'not_covered', evidence: [covered ? '关联 AC 有用例，但断言没有落到该字段' : `关联 AC ${d.acs?.join('、') ?? '（未填）'} 没有用例`] }],
          confidence: 0.58,
          suggestions: [{ target: { kind: 'prompt', ref: 'sdlc/test-design' }, change: `为"${d.title}"这类场景补充边界用例要求` }],
          precheck: { acCovered: covered, cases: covered ? ['TC-001'] : [], codeNodes: ['implement'], reviewedBy: [], gates: ['trace-gate'] },
          by: AUDITOR,
          at: new Date().toISOString(),
        }
        Object.assign(d, { attribution, attributing: false, status: 'attributed' })
      }, 1800)
      return d
    },
    confirm(reqId, id, body) {
      const d = of(reqId).find((x) => x.id === id)
      if (!d?.attribution) return `缺陷 ${id} 还没有归因`
      if (d.status === 'confirmed') return '已经确认过'
      const edited = Boolean(body.attribution)
      if (edited && !body.note?.trim()) return '修改归因需要写备注'
      const at = new Date().toISOString()
      Object.assign(d.attribution, body.attribution ?? {}, { confirmed: { by: human('web'), at, note: body.note?.trim() || undefined, edited } })
      d.status = 'confirmed'
      return { defect: d, cases: regressionCases(d, at) }
    },
  }
}

/** 种子数据里 REQ-001 D-1 已确认，对应回归用例也已存在。 */
export const seedRegressionCases = (): EvalCase[] => regressionCases(D1_REQ1, '2026-11-05T03:05:00Z')
