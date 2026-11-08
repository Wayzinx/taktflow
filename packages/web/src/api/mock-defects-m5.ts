import type { Actor, DefectDetail, DefectMergeSuggestion, MissAssessment, Observation } from '@taktflow/core'

/**
 * 缺陷两层的演示数据（docs/design/21 §4）：观察（不可变）→ 缺陷（有效性与处理状态分开）。
 * REQ-002：
 * - D-1「地址含逗号时 CSV 列错位」：外部缺陷单创建；逐检查点漏检五种结论各一例（含无法判断）；
 * - D-2「金额导出为浮点数」：判决失败创建，复查已确认；csv-writer 评审"拦住了但被放行"；
 * - D-3「Excel 打开地址列被拆开」：另一渠道的缺陷单，和 D-1 有一条待决定的合并建议。
 * 另有几条还没变成缺陷的观察，可以多选后"创建缺陷"。
 */

const RUN2 = 'run-20261104-0002'
const human = (id: string): Actor => ({ type: 'human', id })
const REVIEWER: Actor = { type: 'agent', role: 'reviewer', harness: 'claude-code', model: 'sonnet' }
const JUDGE: Actor = { type: 'agent', role: 'judge', harness: 'claude-code', model: 'sonnet' }
const ENGINE: Actor = { type: 'system', id: 'engine' }
const AUDITOR: Actor = { type: 'agent', role: 'auditor', harness: 'claude-code', model: 'claude-opus-4.1' }

export const cp = (nodeId: string, subject: string, attempt = 1) => `${RUN2}:${nodeId}:${attempt}:1.1:${subject}`
const CP = {
  csvRev: cp('implement/csv-writer/review', 'reviewer'),
  csvSec: cp('implement/csv-writer/review', 'security'),
  uiRev: cp('implement/export-ui/review', 'reviewer'),
  apiRev: cp('implement/export-api/review', 'reviewer'),
  gate: cp('design-gate', 'design-rubric'),
  judge: cp('dev-test-loop/judge', 'judge'),
}

export function seedObservations(): Observation[] {
  return [
    { id: 'external:7c1e', source: 'external', kind: 'report', requirementId: 'REQ-002', title: '收货地址含逗号时 CSV 列错位', detail: '灰度验收：地址 "朝阳区, 望京 SOHO" 的订单导出后后面所有列右移一列。', severity: 'major', at: '2026-11-05T07:48:00Z', by: human('chen'), defects: ['D-1'] },
    { id: `review:${RUN2}:412:1`, source: 'review', kind: 'finding', requirementId: 'REQ-002', runId: RUN2, nodeId: 'implement/csv-writer/review', checkpointId: CP.csvRev, subject: 'ISS-7', severity: 'minor', title: 'writeRow 金额直接 String(x)，精度不稳定', at: '2026-11-04T08:41:00Z', by: REVIEWER, defects: ['D-2'] },
    { id: `review:${RUN2}:418:1`, source: 'review', kind: 'declined', requirementId: 'REQ-002', runId: RUN2, nodeId: 'implement/csv-writer/review', checkpointId: CP.csvRev, subject: 'ISS-7', title: '作者不采纳 ISS-7：金额格式交给前端处理', at: '2026-11-04T08:47:00Z', by: { type: 'agent', role: 'dev', harness: 'codex', model: 'gpt-5-codex' }, defects: ['D-2'] },
    { id: `judge:${RUN2}:503:1`, source: 'judge', kind: 'failure', requirementId: 'REQ-002', runId: RUN2, nodeId: 'dev-test-loop/judge', checkpointId: CP.judge, subject: 'TC-EXP-003', severity: 'major', title: 'TC-EXP-003 金额字段输出 12.5 而不是 12.50', at: '2026-11-04T09:31:00Z', by: JUDGE, defects: ['D-2'] },
    { id: `judge:${RUN2}:503:2`, source: 'judge', kind: 'failure', requirementId: 'REQ-002', runId: RUN2, nodeId: 'dev-test-loop/judge', checkpointId: CP.judge, subject: 'TC-EXP-005', severity: 'major', title: 'TC-EXP-005 超过 1 万行时没有分片，响应超时', at: '2026-11-04T09:31:00Z', by: JUDGE },
    { id: `judge:${RUN2}:503:6`, source: 'judge', kind: 'flaky', requirementId: 'REQ-002', runId: RUN2, nodeId: 'dev-test-loop/judge', checkpointId: CP.judge, subject: 'TC-EXP-002', title: 'TC-EXP-002 文件名日期跨零点，重跑通过', at: '2026-11-04T09:31:00Z', by: JUDGE },
    { id: `review:${RUN2}:233:2`, source: 'review', kind: 'finding', requirementId: 'REQ-002', runId: RUN2, nodeId: 'design-gate', checkpointId: CP.gate, subject: 'design-rubric', severity: 'minor', title: '导出任务没有过期清理方案', at: '2026-11-04T07:12:00Z', by: ENGINE },
    { id: 'human:0b42', source: 'human', kind: 'report', requirementId: 'REQ-002', title: '无导出权限的账号仍能看到导出按钮', detail: '运营只读账号登录后，列表页右上角仍显示"导出"，点了才提示无权限。', severity: 'minor', at: '2026-11-05T09:20:00Z', by: human('qiao') },
    { id: 'external:9d03', source: 'external', kind: 'report', requirementId: 'REQ-002', title: '导出 CSV 用 Excel 打开时地址列被拆成两列', severity: 'major', at: '2026-11-05T10:05:00Z', by: human('lin'), defects: ['D-3'] },
  ]
}

const A = (
  checkpointId: string,
  nodeId: string,
  verdict: MissAssessment['verdict'],
  conditions: MissAssessment['conditions'],
  evidence: string[],
  by: MissAssessment['by'],
  confirmed?: MissAssessment['confirmed'],
): MissAssessment => ({ checkpointId, runId: RUN2, nodeId, verdict, conditions, evidence, by, confirmed })

/** REQ-002 D-1 的逐检查点结论：五种结论各一例（caught_but_waived 在 D-2）。 */
export const D1_CHECKPOINTS: MissAssessment[] = [
  A(CP.csvRev, 'implement/csv-writer/review', 'should_have_caught', { existed: true, materialProvided: true, inDuty: true, executed: true, notRaised: true }, [
    '① 引入点 design/design.md@v1 早于这次评审；快照里的 src/export/csv.ts 第 38–44 行逐字段 join(",")，没有转义',
    '② 快照清单含 src/export/csv.ts 与 design/design.md@v1',
    '③ 职责条目"正确性、边界与测试"覆盖输出格式边界',
    '④ 评审完成，给出 1 条 minor（ISS-7 金额精度）',
    '⑤ 输出里没有关于引号 / 逗号转义的问题',
  ], 'auditor'),
  A(CP.uiRev, 'implement/export-ui/review', 'material_missing', { existed: true, materialProvided: false, executed: true }, ['② 快照清单只有 src/ui/ExportButton.tsx 与 design/design.md，没有 src/export/csv.ts'], 'precheck'),
  A(CP.gate, 'design-gate', 'out_of_scope', { existed: true, materialProvided: true, inDuty: false, executed: true, notRaised: true }, ['③ design-rubric 的检查项只有"契约完整 / 分片方案 / 错误码"，不含输出格式约定'], 'human', { by: human('lin'), at: '2026-11-05T08:30:00Z', note: 'rubric 确实没要求这一项，改进建议里已经提了补一条检查项。' }),
  A(CP.csvSec, 'implement/csv-writer/review', 'not_executed', { executed: false }, ['④ security 评审者调度后被跳过：预算降档到 T1（checkpoint.finished status=skipped）'], 'precheck'),
  A(CP.apiRev, 'implement/export-api/review', 'undetermined', { materialProvided: true, executed: true, notRaised: true }, ['① 评审时 csv.ts 还没写出来，快照里只有接口与任务排队代码；不能证明缺陷当时已存在', '③ 职责条目没有写到输出格式，也没有明确排除'], 'auditor'),
]

export const D2_CHECKPOINTS: MissAssessment[] = [
  A(CP.csvRev, 'implement/csv-writer/review', 'caught_but_waived', { existed: true, materialProvided: true, inDuty: true, executed: true, notRaised: false }, ['⑤ 评审提出了 ISS-7（minor）"金额直接 String(x)"', '作者回应 declined：金额格式交给前端处理；问题台账为"人工不采纳"'], 'precheck', { by: human('lin'), at: '2026-11-04T10:02:00Z' }),
]

export function seedM5Defects(): DefectDetail[] {
  return [
    {
      id: 'D-2', requirementId: 'REQ-002', title: '金额字段导出为浮点数（12.5 而不是 12.50）',
      description: '研发测试 Loop 第 1 轮 TC-EXP-003 失败；评审时提过（ISS-7），作者没采纳。fix-code 第 2 轮已修。',
      severity: 'major', foundAt: '2026-11-04T09:31:00Z', reportedBy: ENGINE, acs: ['AC-2'], status: 'confirmed',
      observations: [`judge:${RUN2}:503:1`, `review:${RUN2}:412:1`, `review:${RUN2}:418:1`], validity: 'valid', resolution: 'verified_fixed', revision: 4,
      attribution: {
        defectId: 'D-2',
        introducedAt: { origin: 'implementation', runId: RUN2, nodeId: 'implement/csv-writer/code', evidence: ['src/export/csv.ts:42 String(row.amount)'] },
        missedBy: [], confidence: 0.9, suggestions: [], precheck: { acCovered: true, cases: ['TC-EXP-003'], codeNodes: ['implement/csv-writer/code'], reviewedBy: ['implement/csv-writer/review'] },
        by: AUDITOR, at: '2026-11-04T10:00:00Z', confirmed: { by: human('lin'), at: '2026-11-04T10:02:00Z', edited: false }, checkpoints: D2_CHECKPOINTS,
      },
    },
    {
      id: 'D-3', requirementId: 'REQ-002', title: '导出 CSV 用 Excel 打开时地址列被拆成两列',
      description: '财务同事反馈：地址里有逗号的行，Excel 打开后地址被拆到两列，后面的金额错位。',
      severity: 'major', foundAt: '2026-11-05T10:05:00Z', reportedBy: human('lin'), status: 'open',
      observations: ['external:9d03'], validity: 'unconfirmed', resolution: 'open', revision: 1,
    },
  ]
}

export function seedMergeSuggestions(): DefectMergeSuggestion[] {
  return [{ id: 'MS-1', defects: ['D-1', 'D-3'], reason: '标题相近（地址 / 逗号 / 列错位），两条缺陷单都指向 src/export/csv.ts 的字段转义', status: 'suggested', at: '2026-11-05T10:06:00Z' }]
}
