import type { Defect, DefectAttribution, DefectOrigin, EvalCase, EvalCaseResult, EvalComparison, EvalRun, EvalTarget, HarnessInfo, MissReason, NodeScorecard } from '@taktflow/core'
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
}

export const CASE_SOURCE: Record<EvalCase['source']['kind'], string> = {
  history: '历史',
  defect: '回归',
  skill: '技能自带',
  manual: '手写',
}

export const targetKey = (t: EvalTarget) => (t.kind === 'node' ? `node:${t.workflowId}/${t.nodeId}` : `skill:${t.name}`)
export const targetLabel = (t: EvalTarget) => (t.kind === 'node' ? `${t.workflowId} / ${t.nodeId}` : `技能 ${t.name}`)

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
