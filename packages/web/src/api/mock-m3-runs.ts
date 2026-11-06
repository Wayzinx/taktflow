/**
 * docs/design/19 的运行级演示数据：路由卡、预算、失败指纹、审批绑定版本、待办派发。
 * - REQ-002：预算告警（token 用到 84%）；
 * - REQ-003：PRD 审批绑定 spec v1，之后 qiao 做了一次措辞修改（v2，cosmetic）→ 审批"已过期"，下游不重跑；
 * - REQ-004：系分门禁同一指纹失败 2 次 → 停止重试，节点 blocked，待办"同样的失败已出现 2 次"；
 * - REQ-007：T1 走 quick-fix（见 mock-quick-fix.ts）。
 */
import type { ArtifactRef, AttentionItem, BudgetStatus, EventPayloads, QualityMetrics, RunBudget, Usage } from '@taktflow/core'
import type { MockDb, MockRun } from './mock-data'
import { ENGINE, ev, insertRunEvents, shift, type RawEvent } from './mock-events'
import { applyNodeMeta, DUTY_MEMBERS } from './mock-m3-nodes'
import { addQuickFix } from './mock-quick-fix'
import { routeOf, seedRoutes } from './mock-route'

const MIN = 60_000
const DEFAULT_BUDGET: RunBudget = { tokens: 1_200_000, costUsd: 12, minutes: 720, concurrency: 4 }
/** 人工节点审批 / 回答时看到的产物（boundTo）。 */
const BOUND: Record<string, string[]> = {
  'answer-clarify': ['spec/clarify.md'],
  'review-spec': ['spec/spec.md'],
  'review-design': ['design/design.md', 'design/contracts.json'],
  'review-cases': ['test-plan/plan.md'],
  acceptance: ['reports/quality.md', 'reports/impact.md'],
  'design-gate': ['design/design.md'],
}

const tokensOf = (u: Usage | undefined) => (u ? u.inputTokens + u.outputTokens : 0)

export function enrichM3(db: MockDb): void {
  addQuickFix(db)
  const routes = seedRoutes()
  for (const run of db.runs.values()) {
    if (run.state.workflowId === 'task') continue
    applyNodeMeta(run)
    run.state.kind ??= 'workflow'
    const seed = routes[run.state.requirementId]
    if (seed && !run.state.route && run.state.status !== 'cancelled') {
      const at = shift(run.state.startedAt, 4_000)
      run.state.route = routeOf(seed.tier, { ...seed, at })
      insertRunEvents(run, [ev(at, 'route.decided', run.state.route.decidedBy, run.state.route)])
    }
    run.state.budget ??= { ...DEFAULT_BUDGET }
  }
  budgetWarning(db)
  staleApproval(db)
  retrySuppressed(db)
}

/** 待办的类别、派发与绑定版本；要在评审演示数据（会补系分修订版本）之后调用。 */
export function decorateAttentions(db: MockDb): void {
  for (const a of db.attention) decorateAttention(db, a)
}

/** REQ-002：预算告警。预算按当时用量反推，保证比例落在 84%。 */
function budgetWarning(db: MockDb) {
  const run = db.runs.get('run-20261104-0002')
  if (!run) return
  const tokens = run.graph.nodes.reduce((s, n) => s + tokensOf(n.usage), 0)
  const cost = run.graph.nodes.reduce((s, n) => s + (n.usage?.costUsd ?? 0), 0)
  run.state.budget = { tokens: Math.round(tokens / 0.84 / 1000) * 1000, costUsd: Math.ceil((cost / 0.6) * 10) / 10, minutes: 360, concurrency: 3 }
  const last = run.events[run.events.length - 1]!
  const minutes = Math.round((Date.parse(last.ts) - Date.parse(run.state.startedAt)) / MIN)
  insertRunEvents(run, [ev(shift(last.ts, -90_000), 'budget.warning', ENGINE, { budget: run.state.budget, used: { tokens: Math.round(tokens * 0.98), costUsd: cost, minutes }, ratio: 0.82 })])
}

/** REQ-003：审批之后 spec 做了措辞修改（cosmetic）：审批过期，但下游节点不标 stale。 */
function staleApproval(db: MockDb) {
  const run = db.runs.get('run-20261104-0003')
  const rec = db.artifacts.get('REQ-003')?.find((a) => a.path === 'spec/spec.md')
  if (!run || !rec || rec.versions.length > 1) return
  const v1 = rec.versions[0]!
  const at = shift(run.state.nodes['design']?.startedAt ?? v1.createdAt, 6 * MIN)
  const key = 'REQ-003:spec/spec.md@1'
  const old = db.contents.get(key)
  if (!old) return
  db.contents.set('REQ-003:spec/spec.md@2', { ...old, content: old.content.replaceAll('验证码', '图形验证码').replaceAll('图形图形', '图形') })
  const reason = '措辞：统一叫"图形验证码"，不改验收含义'
  rec.versions.push({ ...v1, version: 2, sha256: `${v1.sha256.slice(0, 56)}00000002`, createdAt: at, author: { type: 'human', id: 'qiao' }, reason, derivedFrom: [{ workspace: 'REQ-003', path: 'spec/spec.md', version: 1 }], producedBy: undefined })
  insertRunEvents(run, [ev(at, 'artifact.edited', { type: 'human', id: 'qiao' }, { ref: { workspace: 'REQ-003', path: 'spec/spec.md', version: 2 }, reason, impact: 'cosmetic' })])
}

/** REQ-004：系分门禁同一指纹失败第 2 次 → retry.suppressed。 */
function retrySuppressed(db: MockDb) {
  const run = db.runs.get('run-20261104-0004')
  const st = run?.state.nodes['design-gate']
  const g = run?.graph.nodes.find((n) => n.id === 'design-gate')
  if (!run || !st || !g || st.failures) return
  const first = st.endedAt ?? run.state.startedAt
  const second = shift(first, 3 * MIN)
  const fingerprint = '9c1e4b7a2f03d655'
  const message = 'rubric 62 < 阈值 80：契约缺错误码定义，AC-4 时区未覆盖'
  st.attempts = g.attempts = 2
  st.status = g.status = 'blocked'
  st.endedAt = second
  st.error = '同样的失败已出现 2 次（gate:design-rubric），输入 design/design.md@v1 没有变化，已停止重试'
  st.failures = [{ fingerprint, code: 'gate:design-rubric', target: 'design-rubric', inputs: 'design/design.md@1,spec/spec.md@1#4f2a91c0', count: 2, firstAt: first, lastAt: second, message }]
  const gate = run.gates?.['design-gate']
  const items: RawEvent[] = [
    ev(shift(first, 20_000), 'node.started', ENGINE, { attempt: 2 }, 'design-gate'),
    ev(shift(second, -20_000), 'gate.result', ENGINE, { pass: false, checks: (gate?.checks ?? []).map((c) => ({ ...c, kind: 'rubric' as const })) } as EventPayloads['gate.result'], 'design-gate'),
    ev(shift(second, -10_000), 'node.failed', ENGINE, { error: message, attempt: 2 }, 'design-gate'),
    ev(second, 'retry.suppressed', ENGINE, { fingerprint, code: 'gate:design-rubric', count: 2, reason: '同一指纹第 2 次出现，输入身份未变化' }, 'design-gate'),
  ]
  insertRunEvents(run, items)
  const a = db.attention.find((x) => x.requestId === 'att-0004-design-gate')
  if (a) Object.assign(a, { kind: 'retry', createdAt: second, ask: '同样的失败已出现 2 次：系分门禁 rubric 62 < 80（未覆盖 AC-4 跨时区、契约缺错误码），输入没有变化，已停止重试。', form: 'choice', choices: ['再试一次', '交给人处理', '终止运行'] } satisfies Partial<AttentionItem>)
}

function latestVersionAt(db: MockDb, reqId: string, path: string, at: string): number | undefined {
  const rec = db.artifacts.get(reqId)?.find((a) => a.path === path)
  const vs = rec?.versions.filter((v) => Date.parse(v.createdAt) <= Date.parse(at))
  return vs?.length ? vs[vs.length - 1]!.version : undefined
}

function decorateAttention(db: MockDb, a: AttentionItem) {
  a.kind ??= 'node'
  const run = db.runs.get(a.runId)
  const owner = run?.tpl.get(a.nodeId)?.owner
  if (owner) {
    a.owner ??= owner
    a.assignees ??= DUTY_MEMBERS[owner]
  }
  if (!a.boundTo && (a.form === 'approve' || a.kind === 'retry')) {
    const at = a.answeredAt ?? a.createdAt
    const refs = (BOUND[a.nodeId] ?? []).map((path): ArtifactRef | undefined => {
      const version = latestVersionAt(db, a.requirementId, path, at)
      return version ? { workspace: a.requirementId, path, version } : undefined
    })
    const bound = refs.filter((r): r is ArtifactRef => Boolean(r))
    if (bound.length) a.boundTo = bound
  }
}

/** 读模型：boundTo 的产物有新版本即过期。 */
export function attentionView(db: MockDb, a: AttentionItem): AttentionItem {
  if (!a.boundTo?.length) return a
  const stale = a.boundTo.some((r) => {
    const rec = db.artifacts.get(r.workspace)?.find((x) => x.path === r.path)
    return Boolean(rec && r.version !== undefined && rec.versions[rec.versions.length - 1]!.version > r.version)
  })
  return { ...a, stale }
}

/** 预算状态：口径与 core 的 util/budget.ts 一致（各项比例取最大，80% 告警）。 */
export function budgetStatus(run: MockRun, usage: Usage): BudgetStatus | undefined {
  const budget = run.state.budget
  if (!budget) return undefined
  const end = run.state.endedAt ? Date.parse(run.state.endedAt) : Date.now()
  const used = { tokens: tokensOf(usage), costUsd: usage.costUsd, minutes: Math.round((end - Date.parse(run.state.startedAt)) / MIN) }
  const ratio = Math.max(budget.tokens ? used.tokens / budget.tokens : 0, budget.costUsd && used.costUsd !== undefined ? used.costUsd / budget.costUsd : 0, budget.minutes ? used.minutes / budget.minutes : 0)
  return { budget, used, ratio, state: ratio >= 1 ? 'exhausted' : ratio >= 0.8 ? 'warning' : 'ok' }
}

const ZERO_Q = (): QualityMetrics => ({ verified: 0, intercepted: 0, interceptedBy: { gate: 0, review: 0, judge: 0, completion: 0, fingerprint: 0 } })

/** 校验与拦截：从事件流现算（门禁检查、评审轮、判决、完成标准、失败指纹）。 */
export function qualityOf(run: MockRun): QualityMetrics {
  if (run.quality) return run.quality
  const q = ZERO_Q()
  for (const e of run.events) {
    if (e.type === 'gate.result') {
      const d = e.data as EventPayloads['gate.result']
      for (const c of d.checks) c.pass ? q.verified++ : q.interceptedBy.gate++
    } else if (e.type === 'review.round') {
      const d = e.data as EventPayloads['review.round']
      if (d.passed) q.verified++
      else q.interceptedBy.review += d.verdicts.reduce((s, v) => s + v.issues, 0)
    } else if (e.type === 'judge.verdict') {
      q.interceptedBy.judge += (e.data as EventPayloads['judge.verdict']).verdicts.filter((v) => v.category === 'product_bug').length
    } else if (e.type === 'node.checks') {
      if ((e.data as EventPayloads['node.checks']).unmet.length) q.interceptedBy.completion++
    } else if (e.type === 'retry.suppressed') q.interceptedBy.fingerprint++
  }
  const by = q.interceptedBy
  q.intercepted = by.gate + by.review + by.judge + by.completion + by.fingerprint
  return q
}

export function sumQuality(list: QualityMetrics[]): QualityMetrics {
  return list.reduce((acc, q) => {
    acc.verified += q.verified
    acc.intercepted += q.intercepted
    for (const k of Object.keys(acc.interceptedBy) as Array<keyof QualityMetrics['interceptedBy']>) acc.interceptedBy[k] += q.interceptedBy[k]
    return acc
  }, ZERO_Q())
}
