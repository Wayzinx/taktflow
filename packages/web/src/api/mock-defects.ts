import type { Actor, DefectAttribution, DefectConfirmRequest, DefectDetail, DefectMergeSuggestion, DefectReportRequest, DefectUpdateRequest, EvalCase, EvalTarget, MissDecisionRequest, Observation } from '@taktflow/core'
import { D1_CHECKPOINTS, seedM5Defects, seedMergeSuggestions, seedObservations } from './mock-defects-m5'
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
  observations: ['external:7c1e'],
  validity: 'valid',
  resolution: 'open',
  revision: 3,
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
    checkpoints: D1_CHECKPOINTS,
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

/** 写冲突（baseRevision 不一致）：mock 层换成 RevisionConflictError。 */
export interface Conflict {
  conflict: string
}

export interface MockDefects {
  list(reqId: string): DefectDetail[]
  find(defectId: string): DefectDetail | undefined
  observations(reqId: string, opts?: { source?: string; run?: string }): Observation[]
  update(reqId: string, id: string, body: DefectUpdateRequest): DefectDetail | Conflict | string
  mergeSuggestions(reqId: string): DefectMergeSuggestion[]
  decideMerge(reqId: string, sid: string, body: { decision: 'accept' | 'reject' | 'undo'; reason: string }): DefectMergeSuggestion | string
  decideMiss(reqId: string, id: string, checkpointId: string, body: MissDecisionRequest): DefectDetail | Conflict | string
  report(reqId: string, body: DefectReportRequest): DefectDetail | string
  attribute(reqId: string, id: string, runId?: string): DefectDetail | string
  confirm(reqId: string, id: string, body: DefectConfirmRequest): { defect: DefectDetail; cases: EvalCase[] } | string
}

export function createMockDefects(seeded: boolean): MockDefects {
  const store = new Map<string, DefectDetail[]>(seeded ? [['REQ-001', [structuredClone(D1_REQ1)]], ['REQ-002', [structuredClone(D1_REQ2), ...seedM5Defects()]]] : [])
  const obs: Observation[] = seeded ? seedObservations() : []
  const merges: Array<DefectMergeSuggestion & { requirementId: string; prev?: Partial<DefectDetail> }> = seeded ? seedMergeSuggestions().map((m) => ({ ...m, requirementId: 'REQ-002' })) : []
  // 演示"别人刚改过"：REQ-002 D-1 第一次改状态时，先模拟 chen 改了处理状态
  let conflictShown = false
  const of = (reqId: string) => {
    let l = store.get(reqId)
    if (!l) store.set(reqId, (l = []))
    return l
  }
  const view = (d: DefectDetail): DefectDetail => ({ ...d, observationsDetail: (d.observations ?? []).map((id) => obs.find((o) => o.id === id)).filter((o): o is Observation => Boolean(o)) })
  const bump = (d: DefectDetail) => (d.revision = (d.revision ?? 1) + 1)
  const stale = (d: DefectDetail, base: number | undefined): Conflict | undefined =>
    base !== undefined && base !== (d.revision ?? 1) ? { conflict: `${d.id} 刚被别人改过（你看到的是第 ${base} 版，现在是第 ${d.revision ?? 1} 版）` } : undefined
  return {
    list: (reqId) => [...of(reqId)].sort((a, b) => b.foundAt.localeCompare(a.foundAt)).map(view),
    find: (defectId) => [...store.values()].flat().find((d) => d.id === defectId),
    observations: (reqId, opts = {}) => obs.filter((o) => o.requirementId === reqId && (!opts.source || o.source === opts.source) && (!opts.run || o.runId === opts.run)).sort((a, b) => b.at.localeCompare(a.at)),
    update(reqId, id, body) {
      const d = of(reqId).find((x) => x.id === id)
      if (!d) return `缺陷 ${id} 不存在`
      if (!body.reason.trim()) return '需要写原因'
      if (!conflictShown && reqId === 'REQ-002' && id === 'D-1') {
        conflictShown = true
        d.resolution = 'claimed_fixed'
        bump(d)
      }
      const c = stale(d, body.baseRevision)
      if (c) return c
      if (body.validity === 'duplicate' && !body.duplicateOf) return '标为重复时要选和哪个缺陷重复'
      Object.assign(d, { validity: body.validity ?? d.validity, resolution: body.resolution ?? d.resolution, duplicateOf: body.validity === 'duplicate' ? body.duplicateOf : undefined })
      bump(d)
      return view(d)
    },
    mergeSuggestions: (reqId) => merges.filter((m) => m.requirementId === reqId).map(({ requirementId: _r, prev: _p, ...m }) => m),
    decideMerge(reqId, sid, body) {
      const m = merges.find((x) => x.id === sid && x.requirementId === reqId)
      if (!m) return `合并建议 ${sid} 不存在`
      if (!body.reason.trim()) return '需要写原因'
      const [keep, dup] = m.defects.map((id) => of(reqId).find((d) => d.id === id))
      if (body.decision === 'undo') {
        if (m.status !== 'accepted' && m.status !== 'rejected') return '只有已接受或已拒绝的建议可以撤销'
        if (m.status === 'accepted' && dup) {
          Object.assign(dup, m.prev ?? {})
          bump(dup)
        }
        m.status = 'undone'
      } else {
        if (m.status !== 'suggested' && m.status !== 'undone') return '这条建议已经决定过了'
        if (body.decision === 'accept' && dup && keep) {
          m.prev = { validity: dup.validity, duplicateOf: dup.duplicateOf }
          Object.assign(dup, { validity: 'duplicate', duplicateOf: keep.id })
          bump(dup)
        }
        m.status = body.decision === 'accept' ? 'accepted' : 'rejected'
      }
      m.decidedBy = human('web')
      m.at = new Date().toISOString()
      const { requirementId: _r, prev: _p, ...out } = m
      return out
    },
    decideMiss(reqId, id, checkpointId, body) {
      const d = of(reqId).find((x) => x.id === id)
      const a = d?.attribution?.checkpoints?.find((x) => x.checkpointId === checkpointId)
      if (!d || !a) return `缺陷 ${id} 没有检查点 ${checkpointId} 的结论`
      if (!body.reason?.trim()) return '改判需要写原因'
      const c = stale(d, body.baseRevision)
      if (c) return c
      Object.assign(a, { verdict: body.verdict, conditions: { ...a.conditions, ...body.conditions }, by: 'human', confirmed: { by: human('web'), at: new Date().toISOString(), note: body.note?.trim() || body.reason.trim() } })
      bump(d)
      return view(d)
    },
    report(reqId, body) {
      if (!body.title.trim()) return '标题必填'
      if (!body.description.trim()) return '描述必填'
      const l = of(reqId)
      const at = new Date().toISOString()
      const id = `D-${l.length + 1}`
      // 直接录入外部问题时同时生成一条 report 观察；从观察创建时把它们挂到新缺陷上
      const from = body.observations?.length ? body.observations : [`human:${Date.now().toString(36)}`]
      if (!body.observations?.length) obs.push({ id: from[0]!, source: 'human', kind: 'report', requirementId: reqId, title: body.title.trim(), detail: body.description.trim(), severity: body.severity, at, by: human('web') })
      for (const o of obs) if (from.includes(o.id)) o.defects = [...(o.defects ?? []), id]
      const d: DefectDetail = { id, requirementId: reqId, title: body.title.trim(), description: body.description.trim(), severity: body.severity, foundAt: at, reportedBy: human('web'), acs: body.acs, links: body.links, evidence: body.evidence, status: 'open', observations: from, validity: 'unconfirmed', resolution: 'open', revision: 1 }
      l.push(d)
      return view(d)
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
