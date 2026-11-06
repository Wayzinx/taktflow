import type { NodeKind, NodeRecipe, NodeScorecard, Usage } from '@taktflow/core'

/**
 * 评测演示数据：sdlc 的 8 个节点成绩单（docs/design/20 §2）。
 * - automate：playwright-e2e 技能 v3 → v4 后一次通过率 87% → 50%，疑似退化；
 * - review-design：检出率 60%（拦下 3，确认漏检 2）；
 * - implement：REQ-001 D-1 已确认引入于此（逃逸 1）；test-design：D-1 漏检（detection.missed 1）。
 */

export const WF = 'sdlc'
const WF_VERSION = '0.3.0'

interface RecipeSpec {
  key: string
  firstAt: string
  executions: number
  firstPassRate: number
  skills: Array<{ name: string; hash: string }>
  model: string
  harness: string
  promptHash: string
  profileHash: string
}

interface NodeSpec {
  nodeId: string
  title: string
  kind: NodeKind
  role: string
  card: Omit<NodeScorecard, 'key' | 'label' | 'role' | 'executions' | 'firstPassRate' | 'trend'>
  recipes: RecipeSpec[]
}

const u = (input: number, output: number, cost: number): Usage => ({ inputTokens: input, outputTokens: output, cachedTokens: Math.round(input * 0.4), costUsd: cost })
const issues = (blocker: number, major: number, minor: number, nit: number) => ({ blocker, major, minor, nit })
const CC = { harness: 'claude-code', model: 'claude-sonnet-4.5' }
const CX = { harness: 'codex', model: 'gpt-5-codex' }

const rec = (key: string, firstAt: string, executions: number, firstPassRate: number, h: { harness: string; model: string }, skills: RecipeSpec['skills'], promptHash: string, profileHash: string): RecipeSpec => ({ key, firstAt, executions, firstPassRate, skills, promptHash, profileHash, ...h })

const NODES: NodeSpec[] = [
  {
    nodeId: 'spec', title: '编写 spec', kind: 'agent', role: 'pm',
    card: { review: { roundsAvg: 1.4, reworks: 1, issues: issues(0, 3, 5, 4) }, humanEdits: { cosmetic: 3, semantic: 1, rate: 0.29 }, completionUnmet: 1, suppressed: 0, downstream: { requirement_gap: 1 }, escapes: 0, usage: u(212_400, 31_800, 2.41), durationMsAvg: 184_000 },
    recipes: [rec('5b0c2e91a7d34f10', '2026-10-21T02:10:00Z', 6, 0.83, CC, [], 'p:3e1a90c2', 'a:pm-71c0'), rec('8d4f1a0b6c2e7395', '2026-11-01T03:40:00Z', 8, 0.88, CC, [], 'p:9f02be44', 'a:pm-71c0')],
  },
  {
    nodeId: 'design', title: '系分设计', kind: 'agent', role: 'architect',
    card: { review: { roundsAvg: 2.1, reworks: 3, issues: issues(2, 6, 7, 3) }, humanEdits: { cosmetic: 2, semantic: 2, rate: 0.33 }, completionUnmet: 2, suppressed: 0, downstream: { case_defect: 1 }, escapes: 0, usage: u(386_000, 58_200, 4.62), durationMsAvg: 412_000 },
    recipes: [rec('c71e0d5a9b3f2846', '2026-10-20T08:00:00Z', 7, 0.71, CC, [{ name: 'api-contract-review', hash: 'e3b9a1c0' }], 'p:55d1a0e7', 'a:arch-2b19'), rec('0a9e4c7b13d2f568', '2026-10-30T09:20:00Z', 5, 0.6, CC, [{ name: 'api-contract-review', hash: 'f04d2c18' }], 'p:55d1a0e7', 'a:arch-2b19')],
  },
  {
    nodeId: 'review-design', title: '系分交叉评审', kind: 'review', role: 'reviewer',
    card: { review: { roundsAvg: 1.8, reworks: 0, issues: issues(3, 9, 11, 6) }, humanEdits: { cosmetic: 0, semantic: 0 }, completionUnmet: 0, suppressed: 1, downstream: {}, escapes: 0, detection: { caught: 3, missed: 2, rate: 0.6 }, usage: u(298_500, 22_400, 2.98), durationMsAvg: 236_000 },
    recipes: [rec('3f6a2b9c0e1d7548', '2026-10-22T05:00:00Z', 12, 0.92, CC, [{ name: 'api-contract-review', hash: 'f04d2c18' }], 'p:review-6a3e', 'a:rev-90ad')],
  },
  {
    nodeId: 'test-design', title: '测分与用例设计', kind: 'agent', role: 'test-designer',
    card: { review: { roundsAvg: 1.6, reworks: 2, issues: issues(1, 4, 6, 2) }, humanEdits: { cosmetic: 1, semantic: 3, rate: 0.31 }, completionUnmet: 2, suppressed: 0, downstream: { case_defect: 3 }, escapes: 0, detection: { caught: 6, missed: 1, rate: 0.857 }, usage: u(318_900, 64_100, 3.77), durationMsAvg: 351_000 },
    recipes: [rec('9e27c4d0b5a1f836', '2026-10-21T06:30:00Z', 7, 0.71, CX, [], 'p:td-1c88', 'a:td-4e2f'), rec('d18b5f3a2c9e0647', '2026-11-02T02:00:00Z', 6, 0.67, CX, [], 'p:td-7d01', 'a:td-4e2f')],
  },
  {
    nodeId: 'automate', title: '用例转自动化', kind: 'agent', role: 'automation',
    card: { review: { reworks: 0, issues: issues(0, 0, 0, 0) }, humanEdits: { cosmetic: 0, semantic: 2, rate: 0.13 }, completionUnmet: 4, suppressed: 2, downstream: { script_defect: 5, flaky: 1 }, escapes: 0, usage: u(254_300, 71_600, 3.12), durationMsAvg: 298_000 },
    recipes: [
      rec('1c4e8a0f7b2d9365', '2026-10-19T04:00:00Z', 4, 0.75, CX, [{ name: 'playwright-e2e', hash: '7a20e1bd' }], 'p:auto-44f0', 'a:auto-c3d1'),
      rec('9c1e5b7a3d0f2468', '2026-10-25T07:10:00Z', 8, 0.875, CX, [{ name: 'playwright-e2e', hash: '9c1e33f0' }], 'p:auto-44f0', 'a:auto-c3d1'),
      rec('4f7a0c2e9b1d5836', '2026-11-03T01:30:00Z', 6, 0.5, CX, [{ name: 'playwright-e2e', hash: '4f7a8e02' }], 'p:auto-44f0', 'a:auto-c3d1'),
    ],
  },
  {
    nodeId: 'implement', title: '拆分并实现开发任务', kind: 'planner', role: 'dev',
    card: { review: { roundsAvg: 1.3, reworks: 1, issues: issues(0, 2, 5, 7) }, humanEdits: { cosmetic: 2, semantic: 1, rate: 0.17 }, completionUnmet: 1, suppressed: 1, downstream: { product_bug: 4 }, escapes: 1, usage: u(512_000, 98_300, 5.86), durationMsAvg: 522_000 },
    recipes: [rec('6b3d9e1f0a2c7458', '2026-10-21T10:00:00Z', 10, 0.7, CX, [{ name: 'money-format', hash: '2d9c01aa' }, { name: 'csv-export', hash: '81be5f0c' }], 'p:impl-0b7e', 'a:dev-58aa')],
  },
  {
    nodeId: 'dev-test-loop/judge', title: '失败判决', kind: 'judge', role: 'judge',
    card: { review: { reworks: 0, issues: issues(0, 0, 0, 0) }, humanEdits: { cosmetic: 0, semantic: 1, rate: 0.06 }, completionUnmet: 0, suppressed: 0, downstream: {}, escapes: 0, detection: { caught: 14, missed: 0, rate: 1 }, usage: u(402_700, 40_900, 3.96), durationMsAvg: 142_000 },
    recipes: [rec('a05d7c3e1b9f2864', '2026-10-20T11:00:00Z', 18, 0.94, CC, [], 'p:judge-e10c', 'a:judge-7f03')],
  },
  {
    nodeId: 'dev-test-loop/fix-code', title: '修复代码', kind: 'agent', role: 'dev',
    card: { review: { roundsAvg: 1.1, reworks: 0, issues: issues(0, 1, 2, 3) }, humanEdits: { cosmetic: 1, semantic: 0, rate: 0.11 }, completionUnmet: 1, suppressed: 0, downstream: { product_bug: 2 }, escapes: 0, usage: u(188_600, 36_400, 2.24), durationMsAvg: 205_000 },
    recipes: [rec('e8c2f40a6d1b3975', '2026-10-22T12:00:00Z', 9, 0.78, CX, [{ name: 'money-format', hash: '2d9c01aa' }], 'p:fix-31d2', 'a:dev-58aa')],
  },
]

const sumExec = (n: NodeSpec) => n.recipes.reduce((a, r) => a + r.executions, 0)
const weightedFpr = (rs: RecipeSpec[]) => rs.reduce((a, r) => a + r.firstPassRate * r.executions, 0) / Math.max(1, rs.reduce((a, r) => a + r.executions, 0))
const pct = (v: number) => `${Math.round(v * 100)}%`

/** 退化判定（与 core 同口径）：最近配方执行 ≥ 3 且一次通过率比上一个配方低 20 个百分点以上。 */
function regressionOf(rs: RecipeSpec[]): NodeScorecard['regression'] {
  const [prev, last] = rs.slice(-2)
  if (!prev || !last || last.executions < 3 || prev.firstPassRate - last.firstPassRate < 0.2) return undefined
  const changed = last.skills.find((s) => !prev.skills.some((p) => p.name === s.name && p.hash === s.hash))
  const what = changed ? `技能 ${changed.name} 更新（${prev.skills.find((p) => p.name === changed.name)?.hash.slice(0, 4) ?? '无'} → ${changed.hash.slice(0, 4)}）后` : `配方 ${prev.key.slice(0, 6)} → ${last.key.slice(0, 6)} 后`
  return { suspected: true, reason: `${what}一次通过率 ${pct(prev.firstPassRate)} → ${pct(last.firstPassRate)}（${last.executions} 次执行）` }
}

function scale(card: NodeSpec['card'], f: number): NodeSpec['card'] {
  const r = (v: number) => Math.round(v * f)
  const usage = { ...card.usage, inputTokens: r(card.usage.inputTokens), outputTokens: r(card.usage.outputTokens), cachedTokens: r(card.usage.cachedTokens ?? 0), costUsd: (card.usage.costUsd ?? 0) * f }
  return { ...card, usage, completionUnmet: r(card.completionUnmet), suppressed: r(card.suppressed), review: { ...card.review, reworks: r(card.review.reworks) } }
}

/** 节点成绩单的实时调整（确认缺陷后 escapes / detection.missed 增加）。 */
export interface ScorecardAdjust {
  escapes: Map<string, number>
  missed: Map<string, number>
}

function nodeCard(n: NodeSpec, adj: ScorecardAdjust): NodeScorecard {
  const escapes = n.card.escapes + (adj.escapes.get(n.nodeId) ?? 0)
  const extraMissed = adj.missed.get(n.nodeId) ?? 0
  let detection = n.card.detection
  if (detection || extraMissed) {
    const caught = detection?.caught ?? 0
    const missed = (detection?.missed ?? 0) + extraMissed
    detection = { caught, missed, rate: caught + missed > 0 ? caught / (caught + missed) : undefined }
  }
  return {
    key: { by: 'node', workflowId: WF, nodeId: n.nodeId },
    label: n.title,
    role: n.role,
    executions: sumExec(n),
    firstPassRate: weightedFpr(n.recipes),
    ...n.card,
    escapes,
    detection,
    trend: n.recipes.map((r) => ({ recipeKey: r.key, firstAt: r.firstAt, executions: r.executions, firstPassRate: r.firstPassRate })),
    regression: regressionOf(n.recipes),
  }
}

export function mockScorecards(by: NodeScorecard['key']['by'], adj: ScorecardAdjust): NodeScorecard[] {
  const nodes = NODES.map((n) => nodeCard(n, adj))
  if (by === 'node') return nodes
  if (by === 'recipe') {
    return NODES.flatMap((n, i) => {
      const base = nodes[i]!
      const total = sumExec(n)
      return n.recipes.map((r, j) => {
        const prev = n.recipes[j - 1]
        const regression = prev && r.executions >= 3 && prev.firstPassRate - r.firstPassRate >= 0.2 ? regressionOf([prev, r]) : undefined
        return { ...base, ...scale(n.card, r.executions / total), escapes: j === n.recipes.length - 1 ? base.escapes : 0, detection: base.detection, key: { by: 'recipe' as const, workflowId: WF, nodeId: n.nodeId, recipeKey: r.key }, label: `${n.title} · ${r.key.slice(0, 8)}`, executions: r.executions, firstPassRate: r.firstPassRate, trend: [{ recipeKey: r.key, firstAt: r.firstAt, executions: r.executions, firstPassRate: r.firstPassRate }], regression }
      })
    })
  }
  // 技能：每个（技能, 版本）聚合加载了它的配方
  const groups = new Map<string, { name: string; hash: string; items: Array<{ n: NodeSpec; r: RecipeSpec; i: number }> }>()
  NODES.forEach((n, i) => n.recipes.forEach((r) => r.skills.forEach((s) => {
    const k = `${s.name}@${s.hash}`
    const g = groups.get(k) ?? { name: s.name, hash: s.hash, items: [] }
    g.items.push({ n, r, i })
    groups.set(k, g)
  })))
  const versions = new Map<string, RecipeSpec[]>()
  for (const g of groups.values()) versions.set(g.name, [...(versions.get(g.name) ?? []), ...g.items.map((x) => x.r)])
  return [...groups.values()].map((g) => {
    const exec = g.items.reduce((a, x) => a + x.r.executions, 0)
    const first = g.items[0]!
    const base = scale(first.n.card, first.r.executions / sumExec(first.n))
    const all = [...new Set(versions.get(g.name) ?? [])].sort((a, b) => a.firstAt.localeCompare(b.firstAt))
    const idx = all.findIndex((r) => r.skills.some((s) => s.name === g.name && s.hash === g.hash))
    const regression = idx > 0 ? regressionOf([all[idx - 1]!, all[idx]!]) : undefined
    return {
      ...nodes[first.i]!,
      ...base,
      key: { by: 'skill' as const, workflowId: WF, skill: { name: g.name, hash: g.hash } },
      label: `${g.name}@${g.hash.slice(0, 7)}`,
      role: [...new Set(g.items.map((x) => x.n.role))].join(' / '),
      executions: exec,
      firstPassRate: weightedFpr(g.items.map((x) => x.r)),
      escapes: 0,
      detection: undefined,
      trend: all.map((r) => ({ recipeKey: r.key, firstAt: r.firstAt, executions: r.executions, firstPassRate: r.firstPassRate })),
      regression,
    }
  })
}

/** 节点抽屉"配方"：按节点 id 取该节点最近的配方；planner 展开的任务和 loop 体内节点按前缀归到成绩单节点。 */
export function mockRecipe(nodeId: string, kind: NodeKind, role?: string): NodeRecipe | undefined {
  const spec = NODES.find((n) => n.nodeId === nodeId) ?? NODES.find((n) => nodeId.startsWith(`${n.nodeId}/`) && !nodeId.endsWith('/review'))
  if (!['agent', 'review', 'judge', 'planner'].includes(kind) && !(kind === 'gate' && nodeId === 'design-gate')) return undefined
  const r = spec?.recipes.at(-1)
  const fallback = { key: hash16(nodeId), skills: [], ...CC, promptHash: `p:${hash16(nodeId + 'p').slice(0, 8)}`, profileHash: `a:${hash16(role ?? 'x').slice(0, 8)}` }
  const x = r ?? fallback
  return {
    workflowId: WF,
    workflowVersion: WF_VERSION,
    workflowRev: 'r14',
    nodeId,
    kind,
    role: role ?? spec?.role,
    profileHash: x.profileHash,
    promptHash: x.promptHash,
    skills: x.skills,
    harness: x.harness,
    model: x.model,
    effort: 'high',
    lessons: nodeId === 'automate' ? ['L-003'] : nodeId.startsWith('implement') ? ['L-001', 'L-004'] : [],
    recipeKey: x.key,
  }
}

/** 节点 id → 成绩单里的节点 id（链接用）。 */
export function scorecardNodeOf(nodeId: string): string | undefined {
  return (NODES.find((n) => n.nodeId === nodeId) ?? NODES.find((n) => nodeId.startsWith(`${n.nodeId}/`)))?.nodeId
}

function hash16(s: string): string {
  let h = 2166136261
  let out = ''
  for (let k = 0; k < 4; k++) {
    for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619) >>> 0
    h = Math.imul(h ^ k, 2246822507) >>> 0
    out += h.toString(16).padStart(8, '0').slice(0, 4)
  }
  return out
}
