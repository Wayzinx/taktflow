import type { Defect, DefectAttribution, DefectOrigin, EvalCase, EvalCaseResult, EvalComparison, EvalReport, EvalRun, EvalTarget, HarnessInfo, MissAssessment, MissReason, MissVerdict, NodeScorecard, ObservationKind, ObservationSource } from '@taktflow/core'
import type { Tone } from '../../lib/status'

/** 评测与归因的共用文案（评测页、需求页缺陷 Tab、节点抽屉配方区）。 */

export const ORIGIN: Record<DefectOrigin, { label: string; stage?: string }> = {
  requirement: { label: '需求', stage: 'understand' },
  design: { label: '设计', stage: 'design' },
  implementation: { label: '实现', stage: 'loop' },
  test_design: { label: '测试设计', stage: 'test-design' },
  automation: { label: '自动化', stage: 'loop' },
  environment: { label: '环境' },
  external: { label: '外部' },
  unknown: { label: '未知' },
}
export const ORIGIN_ORDER = Object.keys(ORIGIN) as DefectOrigin[]

export const MISS: Record<MissReason, string> = {
  not_covered: '没有覆盖',
  wrong_assertion: '覆盖了但断言错',
  reviewed_but_missed: '评审看过但没发现',
  gate_absent: '缺这项门禁',
  judge_misclassified: '判决分错了类',
  evidence_stale: '证据已过期',
  other: '其他',
}
export const MISS_ORDER = Object.keys(MISS) as MissReason[]

export const SEVERITY: Record<Defect['severity'], { label: string; tone: Tone }> = {
  critical: { label: '严重', tone: 'failed' },
  major: { label: '主要', tone: 'waiting' },
  minor: { label: '次要', tone: 'skipped' },
}

export const DEFECT_STATUS: Record<Defect['status'], { label: string; tone: Tone }> = {
  open: { label: '待归因', tone: 'pending' },
  attributed: { label: '待确认', tone: 'waiting' },
  confirmed: { label: '已确认', tone: 'success' },
  closed: { label: '已关闭', tone: 'skipped' },
}

/** 有效性与处理状态分开记（docs/design/21 §4）；M3 数据没有这两个字段时按 status 推断。 */
export const VALIDITY: Record<NonNullable<Defect['validity']>, { label: string; tone: Tone; hint: string }> = {
  unconfirmed: { label: '有效性待确认', tone: 'pending', hint: '还没有人确认这是不是缺陷' },
  valid: { label: '有效缺陷', tone: 'failed', hint: '确认是缺陷，计入检出率与成绩单' },
  not_defect: { label: '不是缺陷', tone: 'skipped', hint: '按预期工作或需求本来如此，不计入' },
  duplicate: { label: '重复', tone: 'skipped', hint: '与另一个缺陷是同一个问题，按那个计' },
}
export const RESOLUTION: Record<NonNullable<Defect['resolution']>, { label: string; tone: Tone; hint: string }> = {
  open: { label: '未处理', tone: 'pending', hint: '还没有修复' },
  claimed_fixed: { label: '作者称已修', tone: 'waiting', hint: '只有修复方的说法，还没有复查或回归证据' },
  verified_fixed: { label: '复查已确认', tone: 'success', hint: '复查或回归用例证实已修好' },
  accepted_risk: { label: '接受风险', tone: 'skipped', hint: '人工决定不修，带原因进审计' },
  reopened: { label: '重新打开', tone: 'failed', hint: '修过又复现了' },
}
export const validityOf = (d: Pick<Defect, 'validity' | 'status'>): NonNullable<Defect['validity']> => d.validity ?? (d.status === 'confirmed' || d.status === 'closed' ? 'valid' : 'unconfirmed')
export const resolutionOf = (d: Pick<Defect, 'resolution' | 'status'>): NonNullable<Defect['resolution']> => d.resolution ?? (d.status === 'closed' ? 'verified_fixed' : 'open')

/** 漏检结论（替代 M3 的 MissReason）：只有"本该拦住"计入检出率的分母。 */
export const MISS_VERDICT: Record<MissVerdict, { label: string; tone: Tone; hint: string }> = {
  should_have_caught: { label: '本该拦住', tone: 'failed', hint: '五项条件都成立：计为这个检查点的漏检' },
  caught_but_waived: { label: '拦住了但被放行', tone: 'waiting', hint: '检查点提出过，但被作者不采纳或人工放行' },
  material_missing: { label: '没给材料', tone: 'skipped', hint: '相关材料不在它的快照里，不算它的漏检' },
  not_executed: { label: '没执行', tone: 'skipped', hint: '检查点出错或被跳过：是流程问题，不算它的漏检' },
  out_of_scope: { label: '不在职责内', tone: 'skipped', hint: '职责条目明确不包含这类问题' },
  undetermined: { label: '无法判断', tone: 'pending', hint: '证据不足以下结论：不计入，也不当作"不在职责内"' },
}
export const MISS_VERDICT_ORDER = Object.keys(MISS_VERDICT) as MissVerdict[]
export const MISS_CONDITIONS: Array<{ key: keyof MissAssessment['conditions']; n: string; label: string }> = [
  { key: 'existed', n: '①', label: '当时已存在' },
  { key: 'materialProvided', n: '②', label: '材料在快照里' },
  { key: 'inDuty', n: '③', label: '在职责内' },
  { key: 'executed', n: '④', label: '执行完成' },
  { key: 'notRaised', n: '⑤', label: '输出没提出' },
]
export const ASSESSED_BY: Record<MissAssessment['by'], string> = { precheck: '预检', auditor: 'auditor 建议', human: '人工' }

export const OBS_SOURCE: Record<ObservationSource, string> = { review: '评审', judge: '判决', gate: '门禁', human: '人工', external: '外部' }
export const OBS_KIND: Record<ObservationKind, { label: string; tone: Tone }> = {
  finding: { label: '提出问题', tone: 'waiting' },
  claimed_fixed: { label: '作者称已修', tone: 'waiting' },
  verified_fixed: { label: '复查已修', tone: 'success' },
  declined: { label: '作者不采纳', tone: 'skipped' },
  waived: { label: '人工放行', tone: 'skipped' },
  failure: { label: '执行失败', tone: 'failed' },
  ignored: { label: '判为忽略', tone: 'skipped' },
  flaky: { label: '不稳定', tone: 'pending' },
  gate_fail: { label: '门禁未过', tone: 'failed' },
  gate_error: { label: '检查出错', tone: 'waiting' },
  report: { label: '缺陷单', tone: 'failed' },
}

export const SUGGESTION: Record<DefectAttribution['suggestions'][number]['target']['kind'], string> = {
  skill: '技能',
  prompt: 'Prompt',
  completion: '完成标准',
  review_focus: '评审侧重点',
  gate_check: '门禁检查',
  lesson: '经验',
  knowledge: '知识',
}

export const VERDICT_META: Record<EvalComparison['verdict'], { label: string; tone: Tone }> = {
  better: { label: '更好', tone: 'success' },
  worse: { label: '更差', tone: 'failed' },
  same: { label: '持平', tone: 'skipped' },
  inconclusive: { label: '无定论', tone: 'pending' },
}

export const RUN_STATE: Record<EvalRun['status'], { label: string; tone: Tone }> = {
  running: { label: '运行中', tone: 'running' },
  done: { label: '完成', tone: 'success' },
  failed: { label: '失败', tone: 'failed' },
  refused: { label: '拒绝启动', tone: 'waiting' },
}

export const CASE_SOURCE: Record<EvalCase['source']['kind'], string> = {
  history: '历史',
  defect: '回归',
  skill: '技能自带',
  manual: '手写',
}

/** 检查点样本（docs/design/21 §6）。 */
export const SAMPLE_KIND: Record<NonNullable<EvalCase['sample']>['kind'], { label: string; tone: Tone; hint: string }> = {
  must_catch: { label: '必须拦住', tone: 'failed', hint: '来自人确认的漏检：回放时期望提出这个问题' },
  clean: { label: '无缺陷', tone: 'success', hint: '人确认无问题的评审调用：回放时提出 blocker / major 记误报' },
}

/** 每次回放的结论：环境错误、无法回放、评委判不了都算证据不足，不算通过。 */
export const REPLAY_OUTCOME: Record<'pass' | 'fail' | 'insufficient', { label: string; tone: Tone }> = {
  pass: { label: '通过', tone: 'success' },
  fail: { label: '失败', tone: 'failed' },
  insufficient: { label: '证据不足', tone: 'pending' },
}

export const GATE_VERDICT: Record<NonNullable<EvalReport['gate']>['verdict'], { label: string; tone: Tone; hint: string }> = {
  pass: { label: '达标', tone: 'success', hint: '按开始时的门槛快照判定，可以作为发布依据' },
  fail: { label: '不达标', tone: 'failed', hint: '按开始时的门槛快照判定，不能发布' },
  not_applicable: { label: '不适用', tone: 'skipped', hint: '样本、重复次数或隔离不满足门槛前提，只作参考' },
}

export const ISOLATION_MODE: Record<NonNullable<NonNullable<EvalRun['isolation']>['mode']>, { label: string; hint: string; tone: Tone }> = {
  sandbox: { label: '沙箱隔离', hint: 'bwrap / docker：快照只读挂载，网络关闭', tone: 'success' },
  harness_readonly: { label: 'harness 只读', hint: 'harness 声明了 readOnly 能力，回放时不加载写工具与 shell', tone: 'success' },
  simulated: { label: '模拟隔离', hint: 'mock harness：只用于测试和演示，报告不作发布依据', tone: 'waiting' },
}

export const targetKey = (t: EvalTarget) => (t.kind === 'node' ? `node:${t.workflowId}/${t.nodeId}` : `skill:${t.name}`)
export const targetLabel = (t: EvalTarget) => (t.kind === 'node' ? `${t.workflowId} / ${t.nodeId}` : `技能 ${t.name}`)

/**
 * 长 id 的显示形式（完整 id 放 title）：eval-<uuid> → eval-a25c8be3，sample-<哈希> → sample-3d54c81f，
 * 纯哈希（候选包、评委）→ 前 12 位；其余原样。
 */
export const shortId = (id: string) => {
  const m = /^(eval|sample|cand(?:-j)?)-([0-9a-f]{8})[0-9a-f-]{8,}$/.exec(id)
  if (m) return `${m[1]}-${m[2]}`
  return /^[0-9a-f]{32,}$/.test(id) ? id.slice(0, 12) : id
}

/** 0..1 → "62%"；缺省为 "—"。 */
export const pct = (v: number | undefined) => (v === undefined || !Number.isFinite(v) ? '—' : `${Math.round(v * 100)}%`)
export const shortHash = (h: string | undefined, n = 8) => (h ? h.replace(/^[a-z]+:/, '').slice(0, n) : '—')

/**
 * 基线与候选：以服务端 comparison.baseline / candidate 为准（用户可能自己给变体起名 baseline，或传了多个变体）；
 * 还没有 comparison（运行中、失败）时退回"第一个是基线、其余第一个是候选"的请求约定。
 */
export function variantPair(run: EvalRun): { baseline?: EvalRun['variants'][number]; candidate?: EvalRun['variants'][number] } {
  const byId = (id?: string) => (id ? run.variants.find((v) => v.id === id) : undefined)
  const c = run.comparison
  if (c) return { baseline: byId(c.baseline), candidate: byId(c.candidate) }
  return { baseline: run.variants[0], candidate: run.variants[1] }
}

/**
 * 成绩单的稳定 key（也是 `?card=` 的值）。节点视图按 workflow + 节点分组（服务端 scorecards.ts 同样以 workflowId/nodeId 分组），
 * 只用 nodeId 会让 quick-fix 与 taktflow-standard 的同名节点（implement、review-code…）撞 key。
 */
export const cardKey = (c: NodeScorecard) =>
  c.key.by === 'recipe' ? c.key.recipeKey! : c.key.by === 'skill' ? `${c.key.skill!.name}@${c.key.skill!.hash ?? ''}` : c.key.workflowId ? `${c.key.workflowId}/${c.key.nodeId}` : c.key.nodeId!

/**
 * `?card=` → 成绩单：精确匹配 cardKey；旧链接只带节点 id（?node=implement）时退回第一个同名节点；
 * 数据里没有这个子节点（例如演示数据只给顶层节点）时退回最长的路径前缀（wf/implement/T-1 → wf/implement）。
 */
export function findCard(cards: NodeScorecard[], open: string): NodeScorecard | undefined {
  const exact = cards.find((c) => cardKey(c) === open) ?? cards.find((c) => c.key.by === 'node' && c.key.nodeId === open)
  if (exact) return exact
  return cards
    .filter((c) => c.key.by === 'node' && open.startsWith(`${cardKey(c)}/`))
    .sort((a, b) => cardKey(b).length - cardKey(a).length)[0]
}

export type Outcome = 'win' | 'loss' | 'tie'
export const OUTCOME: Record<Outcome, string> = { win: '胜', loss: '负', tie: '平' }

/**
 * 单条用例的胜负：必须与服务端 compareEval（packages/core/src/eval/runner.ts）的规则保持一致——
 * 先比是否通过，通过性相同时分差 ≥ 5 才算胜负，否则平。服务端没有返回逐用例结论，改规则时两处一起改。
 */
export function caseOutcome(b?: EvalCaseResult, c?: EvalCaseResult): Outcome | undefined {
  if (!b || !c) return undefined
  if (b.pass !== c.pass) return c.pass ? 'win' : 'loss'
  const d = (c.score ?? 0) - (b.score ?? 0)
  return Math.abs(d) >= 5 ? (d > 0 ? 'win' : 'loss') : 'tie'
}

/**
 * HarnessSelector.harness 是必填的：只填了模型时，按角色选默认 harness（roles 里有这个角色的可用 harness），
 * 再退回第一个可用的；空间里一个可用 harness 都没有时返回 undefined，由提交按钮拦下。
 */
export function defaultHarness(harnesses: HarnessInfo[] | undefined, role: string | undefined): string | undefined {
  const usable = (harnesses ?? []).filter((h) => h.available)
  return (role ? usable.find((h) => h.roles.includes(role)) : undefined)?.id ?? usable[0]?.id
}

/**
 * 成绩单行的标题与副标题。服务端节点视图的 label 就是 `<workflow>/<node>`（没有节点标题），
 * 这时标题只放节点 id、副标题放 workflow，避免同一串路径在两行里各出现一次；有真正的标题时原样显示。
 */
export function cardTitle(c: NodeScorecard): { title: string; sub: string } {
  const role = c.role ? ` · ${c.role}` : ''
  if (c.key.by === 'node' && c.key.workflowId && c.key.nodeId) {
    const plain = c.label === `${c.key.workflowId}/${c.key.nodeId}` || c.label === c.key.nodeId
    return plain ? { title: c.key.nodeId, sub: `${c.key.workflowId}${role}` } : { title: c.label, sub: `${c.key.workflowId}/${c.key.nodeId}${role}` }
  }
  return { title: c.label, sub: `${c.key.nodeId ?? c.key.skill?.name ?? ''}${role}` }
}
