/**
 * 评审演示数据（贴近 examples/standard-delivery）：把运行演示数据里的评审节点换成 review 节点并补上轮次记录。
 * - REQ-001：PRD 第 1 轮要求修改、第 2 轮通过；系分连续 3 轮不通过 → 打回重新设计一次 → 第 4 轮通过；两个任务的代码评审 1 轮通过；
 * - REQ-003：系分评审第 1 轮 agent 全部通过，等人确认。
 * 轮次编号跨打回连续递增（1..4）；ReviewSummary.round 是本次打回之后的轮次。
 */
import type { Actor, ArtifactRef, EventEnvelope, EventPayloads, EventType, NodeDetail, ReviewContinuity, ReviewDisposition, ReviewDispositionRequest, ReviewFacets, ReviewIssue, ReviewRecord, ReviewResponse, ReviewRound, ReviewStatus, ReviewSummary, ReviewVerdict } from '@taktflow/core'
import * as C from './mock-content'
import type { MockDb, MockRun } from './mock-data'

type ReviewView = NonNullable<NodeDetail['review']>
interface MockReview extends ReviewView {
  runId: string
  nodeId: string
  title: string
  reworks: number
  dispositions: ReviewDisposition[]
}

const agent = (role: string): Actor => ({ type: 'agent', role, harness: role === 'test-designer' || role === 'dev' ? 'codex' : 'claude-code', model: role === 'dev' || role === 'test-designer' ? 'gpt-5-codex' : 'sonnet' })
const ENGINE: Actor = { type: 'system', id: 'engine' }
const issue = (id: string, severity: ReviewIssue['severity'], location: string, description: string, suggestion?: string, title?: string, category = 'correctness'): ReviewIssue => ({ id, severity, location, description, suggestion, title: title ?? description.split(/[，。：]/)[0]!.slice(0, 20), category })
const rec = (reviewer: string, verdict: ReviewVerdict, score: number, summary: string, issues: ReviewIssue[] = []) => ({ reviewer, verdict, score, summary, issues })
const resp = (issueId: string, reviewer: string, action: ReviewResponse['action'], note: string) => ({ issueId, reviewer, action, note })

interface RoundSpec {
  records: Array<Omit<ReviewRecord, 'round' | 'artifacts' | 'at'>>
  responses?: Array<Omit<ReviewResponse, 'round'>>
  /** 本轮评审看到的产物版本。 */
  sees: ArtifactRef[]
  revised?: ArtifactRef[]
  /** 连续无进展提前结束（stopAfterNoProgress）。 */
  stopReason?: 'no_progress'
}

const PRD_ROUNDS = (ws: string): RoundSpec[] => [
  {
    sees: [{ workspace: ws, path: 'spec/spec.md', version: 1 }],
    records: [
      rec('architect', 'approve', 86, '范围清楚，改动只在 greet()，不涉及接口和数据。', [issue('R1-A1', 'nit', 'spec/spec.md#术语', '"默认称呼"和"stranger"混用，建议统一叫 DEFAULT_NAME。')]),
      rec('test-designer', 'request_changes', 68, 'AC-2 的"空名字"边界不完整，AC-3 缺少可断言的期望值。', [
        issue('R1-T1', 'major', 'spec/spec.md#AC-2', 'AC-2 只列了 "" 和 "   "，没覆盖全角空格（\\u3000），输入法里很常见。', '把全角空格也视为空名字，并在 AC-2 里列出。'),
        issue('R1-T2', 'minor', 'spec/spec.md#AC-3', 'AC-3 只写"返回默认问候语"，没有给出具体文本，用例无法断言。', '写明返回 "Hello, stranger!"。'),
      ]),
    ],
    responses: [resp('R1-T1', 'test-designer', 'fixed', 'AC-2 已补充全角空格。'), resp('R1-T2', 'test-designer', 'fixed', 'AC-3 写明期望文本。'), resp('R1-A1', 'architect', 'deferred', '命名放到系分里统一。')],
    revised: [{ workspace: ws, path: 'spec/spec.md', version: 2 }],
  },
  { sees: [{ workspace: ws, path: 'spec/spec.md', version: 2 }], records: [rec('architect', 'approve', 92, '可以进入系分。'), rec('test-designer', 'approve', 88, 'AC 全部可验证。')] },
]

const DESIGN_ROUNDS = (ws: string): RoundSpec[] => {
  const d = (version: number): ArtifactRef[] => [{ workspace: ws, path: 'design/design.md', version }, { workspace: ws, path: 'design/contracts.json', version: 1 }]
  return [
    {
      sees: d(1),
      records: [
        rec('pm', 'approve', 84, '覆盖了全部 AC。'),
        rec('test-designer', 'request_changes', 62, '契约没有说明 null / undefined 的行为。', [issue('D1-T1', 'major', 'design/contracts.json#greet', '入参为 null 或 undefined 时的返回值未定义，用例无从断言。', '契约里写明：非字符串一律视为空名字。', '非字符串入参', 'testability')]),
        rec('reviewer', 'request_changes', 70, '方案直接 trim 输入，会改变存量输出。', [issue('D1-R1', 'blocker', 'design/design.md#方案', 'greet() 先 trim 再拼接，"  bob  " 的输出会从 "Hello,   bob  !" 变成 "Hello, bob!"，存量调用方有快照测试。', 'trim 只用于判空，输出保留原值。')]),
      ],
      responses: [resp('D1-T1', 'test-designer', 'fixed', '契约补充非字符串入参。'), resp('D1-R1', 'reviewer', 'fixed', '改为 trim 后判空。')],
      revised: d(2),
    },
    {
      sees: d(2),
      records: [
        rec('pm', 'approve', 86, '没有问题。'),
        rec('test-designer', 'approve', 80, '契约已可验证，只剩一处边界。', [issue('D2-T1', 'minor', 'design/contracts.json#greet', '契约写了非字符串视为空名字，但数字 0 被当成空名字还是转成 "0" 没写。', '写明：数字一律 String() 后再判空。', '非字符串入参', 'testability')]),
        rec('reviewer', 'request_changes', 74, '判空逻辑写在 CLI 和 HTTP 两个入口，没有收敛到 greet()。', [issue('D2-R1', 'major', 'design/design.md#改动范围', 'cli/hello.js 和 server/routes/greet.js 各自判空，两处规则容易漂移。', '判空只放在 greet() 内部，入口不做处理。', '入口判空')]),
      ],
      responses: [resp('D2-R1', 'reviewer', 'declined', 'HTTP 入口需要提前返回 400，保留入口判空。')],
      revised: d(3),
    },
    {
      sees: d(3),
      records: [
        rec('pm', 'approve', 85, '同意。'),
        rec('test-designer', 'approve', 82, '同意。'),
        rec('reviewer', 'request_changes', 66, '入口判空与 PRD 冲突：PRD 要求空名字返回问候语，不是 400。', [issue('D3-R1', 'blocker', 'design/design.md#改动范围', 'HTTP 入口对空名字返回 400，与 AC-1 "返回 Hello, stranger!" 矛盾。', '回到上一轮的建议：只在 greet() 内判空。', '入口判空')]),
      ],
    },
    { sees: d(4), records: [rec('pm', 'approve', 90, '重新设计后范围更小。'), rec('test-designer', 'approve', 88, '契约与 AC 一一对应。'), rec('reviewer', 'approve', 91, '判空收敛到 greet()，入口不变，回归面最小。')] },
  ]
}

const CODE_ROUND = (ws: string, task: string, summary: string): RoundSpec[] => [{ sees: [{ workspace: ws, path: `tasks/${task}.md`, version: 1 }], records: [rec('reviewer', 'approve', 90, summary)] }]

/** REQ-004 的 PRD 评审：同一个 major 问题连续两轮没有进展，提前结束交人。 */
const REQ4_SPEC = (ws: string): RoundSpec[] => {
  const tz = issue('S4-T1', 'major', 'spec/spec.md#AC-4', 'AC-4 只写"按本地时间"，没说明用户时区从哪里取、取不到怎么办。', '写明时区来源（用户资料 > 设备 > 默认 Asia/Shanghai）。')
  return [
    { sees: [{ workspace: ws, path: 'spec/spec.md', version: 1 }], records: [rec('test-designer', 'request_changes', 66, 'AC-4 不可测。', [tz])], responses: [resp('S4-T1', 'test-designer', 'deferred', '时区来源要等用户中心确认，先保留原文。')] },
    { sees: [{ workspace: ws, path: 'spec/spec.md', version: 1 }], records: [rec('test-designer', 'request_changes', 66, 'AC-4 仍不可测，问题没有变化。', [tz])], stopReason: 'no_progress' },
  ]
}

const REQ3_DESIGN = (ws: string): RoundSpec[] => [
  {
    sees: [{ workspace: ws, path: 'design/design.md', version: 1 }],
    records: [
      rec('pm', 'approve', 83, '覆盖 AC-1～AC-3。'),
      rec('test-designer', 'approve', 80, '可测。', [issue('C1-T1', 'minor', 'design/contracts.json#errors', 'CAPTCHA_EXPIRED 与 NEED_CAPTCHA 的前端处理没区分。', '契约里写明前端分别如何提示。')]),
      rec('reviewer', 'request_changes', 64, '"Redis 不可用时不校验"会在故障期放开撞库。', [issue('C1-R1', 'blocker', 'design/design.md#风险', 'Redis 降级为不校验会让撞库在故障期间不受限。', '降级时改为固定要求验证码，或交人决定。')]),
      { ...rec('tech-lead', 'approve', 80, '裁决：两位评审者通过、reviewer 提 blocker。降级策略属于产品取舍，本轮按通过处理，blocker 转人工确认（签核时一并决定）。'), arbiter: true },
    ],
  },
]

/** 在 a、b 之间均匀取第 i 个时刻。 */
const lerp = (a: string | undefined, b: string | undefined, i: number, n: number) => {
  const s = Date.parse(a ?? new Date().toISOString())
  const e = b ? Date.parse(b) : s + n * 4 * 60_000
  return new Date(s + ((e - s) * (i + 1)) / (n + 1)).toISOString()
}

const norm = (x: string | undefined) => (x ?? '').toLowerCase().replace(/\s+/g, '')
/** 与引擎同口径的演示版：groupKey = 位置 + 类别 + 标题归一化；fingerprint = 位置、严重度、描述。 */
const groupKeyOf = (i: ReviewIssue) => `${norm(i.location)}|${norm(i.category)}|${norm(i.title)}`
const fingerprintOf = (i: ReviewIssue) => {
  let h = 0
  for (const ch of `${i.location}|${i.severity}|${i.description}`) h = (h * 31 + ch.charCodeAt(0)) >>> 0
  return h.toString(16).padStart(8, '0')
}

/**
 * 每 maxRounds 轮之后发生过一次打回（reworked）时，后续轮次进入新修订、轮次从 1 重新计数；seq 全局递增。
 * continuity 与上一轮（跨修订也比）比较问题：新增 / 重复 / 有变化 / 本轮未提及；上轮回应"已修"却再次出现记为回潮。
 */
function buildRounds(run: MockRun, nodeId: string, specs: RoundSpec[], maxRounds = Infinity, reworked = false): ReviewRound[] {
  const st = run.state.nodes[nodeId]!
  const out: ReviewRound[] = []
  specs.forEach((s, i) => {
    const revision = reworked ? Math.floor(i / maxRounds) + 1 : 1
    const round = reworked ? (i % maxRounds) + 1 : i + 1
    const records = s.records.map((r) => ({ ...r, round, artifacts: s.sees, at: lerp(st.startedAt, st.endedAt, i, specs.length), issues: r.issues.map((x) => ({ ...x, groupKey: groupKeyOf(x), fingerprint: fingerprintOf(x) })) }))
    const prev = out[out.length - 1]
    const continuity: ReviewContinuity[] = []
    if (prev) {
      const prevIssues = prev.records.flatMap((r) => r.issues.map((x) => ({ x, reviewer: r.reviewer })))
      const cur = records.flatMap((r) => r.issues.map((x) => ({ x, reviewer: r.reviewer })))
      for (const c of cur) {
        const p = prevIssues.find((q) => q.x.groupKey === c.x.groupKey)
        const fixed = p && prev.responses.some((r) => r.issueId === p.x.id && r.action === 'fixed')
        continuity.push({ groupKey: c.x.groupKey!, issueId: c.x.id, reviewer: c.reviewer, prevIssueId: p?.x.id, observation: !p ? 'new' : p.x.fingerprint === c.x.fingerprint ? 'repeated' : 'changed', regressed: fixed || undefined })
      }
      for (const p of prevIssues) if (!cur.some((c) => c.x.groupKey === p.x.groupKey)) continuity.push({ groupKey: p.x.groupKey!, reviewer: p.reviewer, prevIssueId: p.x.id, observation: 'not_observed' })
    }
    out.push({
      round,
      revision,
      seq: i + 1,
      passed: s.records.some((r) => r.arbiter) ? s.records.find((r) => r.arbiter)!.verdict === 'approve' : s.records.every((r) => r.verdict === 'approve'),
      stopReason: s.stopReason,
      records,
      responses: (s.responses ?? []).map((r) => ({ ...r, round })),
      revised: s.revised ?? [],
      targetFingerprint: s.sees.map((a) => `${a.path}@${a.version ?? '?'}`).join(','),
      continuity: prev ? continuity : undefined,
    })
  })
  return out
}

/** 系分修订版本：在原文末尾追加"评审修订"段落，保证轮次之间有可看的差异。 */
function addDesignVersions(db: MockDb, ws: string, runId: string) {
  const rec = db.artifacts.get(ws)?.find((a) => a.path === 'design/design.md')
  if (!rec || rec.versions.length > 1) return
  const notes = ['- 契约：非字符串入参视为空名字。\n- 方案：trim 只用于判空，输出保留原值。', '- 入口：CLI 与 HTTP 入口各自判空，HTTP 返回 400。', '- 重新设计：判空只在 greet() 内部；入口不变；HTTP 对空名字照常返回 200 与默认问候语。']
  let content = C.DESIGN
  notes.forEach((note, i) => {
    content += `\n\n## 评审修订 v${i + 2}\n\n${note}\n`
    const version = i + 2
    const node = i === 2 ? 'design' : 'review-design'
    db.contents.set(`${ws}:design/design.md@${version}`, { content, mediaType: rec.mediaType })
    rec.versions.push({ ...rec.versions[0]!, version, size: content.length, sha256: `${rec.versions[0]!.sha256.slice(0, 56)}${version.toString(16).padStart(8, '0')}`, author: agent('architect'), reason: i === 2 ? '打回重新设计（第 1 次）' : `按评审意见修改（第 ${i + 1} 轮）`, derivedFrom: [{ workspace: ws, path: 'design/design.md', version: version - 1 }], producedBy: { runId, nodeId: node } })
  })
}

/** 把评审事件按时间插入运行事件流，并重排 seq 与哈希链。 */
function insertEvents(run: MockRun, items: Array<{ ts: string; nodeId: string; type: EventType; actor: Actor; data: EventPayloads[EventType] }>) {
  const all = [...run.events, ...items.map((x) => ({ ...x, runId: run.state.runId, seq: 0, prevHash: '', hash: '' }) as EventEnvelope)]
  all.sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts))
  let prev = '0'.repeat(64)
  all.forEach((e, i) => {
    e.seq = i + 1
    e.prevHash = prev
    e.hash = prev = (prev.slice(8) + e.seq.toString(16).padStart(8, '0')).slice(-64)
  })
  run.events = all
}

export interface MockReviews {
  list(requirementId: string): ReviewSummary[]
  detail(runId: string, nodeId: string): ReviewView | undefined
  /** 返回字符串表示校验失败。 */
  dispose(runId: string, nodeId: string, body: ReviewDispositionRequest): ReviewDisposition | string
}

export function createMockReviews(db: MockDb): MockReviews {
  const reviews: MockReview[] = []

  function convert(runId: string, nodeId: string, title: string, config: ReviewView['config'], specs: RoundSpec[], status: ReviewStatus, rework?: string) {
    const run = db.runs.get(runId)
    const t = run?.tpl.get(nodeId)
    const g = run?.graph.nodes.find((n) => n.id === nodeId)
    if (!run || !t || !g || !run.state.nodes[nodeId]) return
    t.kind = g.kind = 'review'
    t.title = g.title = title
    const rounds = buildRounds(run, nodeId, specs, config.maxRounds, Boolean(rework))
    const reworks = rework ? 1 : 0
    const st = run.state.nodes[nodeId]!
    const last = rounds[rounds.length - 1]
    st.round = g.round = last?.round
    st.revision = g.revision = last?.revision ?? 1
    g.reworks = reworks
    if (rework) {
      run.state.nodes[rework]!.reworks = 1
      run.graph.edges.push({ from: nodeId, to: rework, kind: 'route', label: '打回' })
    }
    const author = agent(config.author)
    const events: Parameters<typeof insertEvents>[1] = []
    for (const r of rounds) {
      const ts = r.records[0]!.at
      events.push({ ts, nodeId, type: 'review.round', actor: ENGINE, data: { round: r.round, passed: r.passed, verdicts: r.records.map((x) => ({ reviewer: x.reviewer, verdict: x.verdict, score: x.score, issues: x.issues.length })) } })
      if (r.responses.length) events.push({ ts: new Date(Date.parse(ts) + 60_000).toISOString(), nodeId, type: 'review.response', actor: author, data: { round: r.round, responses: r.responses, revised: r.revised } })
      const arb = r.records.find((x) => x.arbiter)
      if (arb) events.push({ ts: new Date(Date.parse(ts) + 20_000).toISOString(), nodeId, type: 'review.arbitrated', actor: agent(arb.reviewer), data: { round: r.round, arbiter: arb.reviewer, verdict: arb.verdict, conflict: '评审者结论冲突：有人通过，有人要求修改且含 blocker' } })
      if (r.stopReason) events.push({ ts: new Date(Date.parse(ts) + 30_000).toISOString(), nodeId, type: 'review.exhausted', actor: ENGINE, data: { rounds: r.round, action: 'human', reason: 'no_progress' } })
      if (rework && r.round === config.maxRounds && r.revision === 1) {
        const at = new Date(Date.parse(ts) + 30_000).toISOString()
        events.push({ ts: at, nodeId, type: 'review.exhausted', actor: ENGINE, data: { rounds: config.maxRounds, action: 'rework' } })
        events.push({ ts: at, nodeId, type: 'rework.started', actor: ENGINE, data: { from: nodeId, to: rework, count: 1, feedback: r.records.flatMap((x) => x.issues.map((i) => i.description)).join('\n'), reset: [rework, nodeId] } })
      }
    }
    insertEvents(run, events)
    reviews.push({ runId, nodeId, title, config, rounds, status, reworks, dispositions: [] })
  }

  const R1 = 'run-20261104-0001'
  if (db.runs.has(R1)) {
    const specRec = db.artifacts.get('REQ-001')?.find((a) => a.path === 'spec/spec.md')?.versions[1]
    if (specRec) Object.assign(specRec, { author: agent('pm'), reason: '按评审意见修改（第 1 轮）', producedBy: { runId: R1, nodeId: 'review-spec' } })
    addDesignVersions(db, 'REQ-001', R1)
    const review = (target: string[], author: string, reviewers: string[], rework: string) => ({ target, author, reviewers: reviewers.map((role) => ({ role })), pass: 'all' as const, maxRounds: 3, onExhausted: { rework, maxReworks: 1 }, humanSignoff: true })
    convert(R1, 'review-spec', 'PRD 交叉评审', review(['spec/spec.md'], 'pm', ['architect', 'test-designer'], 'spec'), PRD_ROUNDS('REQ-001'), 'passed')
    convert(R1, 'review-design', '系分交叉评审', review(['design/**'], 'architect', ['pm', 'test-designer', 'reviewer'], 'design'), DESIGN_ROUNDS('REQ-001'), 'passed', 'design')
    const codeReview = { target: { code: { repo: 'app' } }, author: 'dev', reviewers: [{ role: 'reviewer', focus: '正确性、边界与测试' }], pass: 'all' as const, maxRounds: 3, onExhausted: { rework: 'code', maxReworks: 1 }, humanSignoff: false }
    convert(R1, 'implement/greet-core/review', '代码评审：默认称呼常量', codeReview, CODE_ROUND('REQ-001', 'greet-core', '常量导出位置合理，单测覆盖。'), 'passed')
    convert(R1, 'implement/greet-empty/review', '代码评审：空名字分支', codeReview, CODE_ROUND('REQ-001', 'greet-empty', '判空覆盖 ""、空格和全角空格，输出保留原值。'), 'passed')
  }
  const R3 = 'run-20261104-0003'
  if (db.runs.has(R3)) {
    convert(R3, 'review-design', '系分交叉评审', { target: ['design/**'], author: 'architect', reviewers: [{ role: 'pm' }, { role: 'test-designer' }, { role: 'reviewer', focus: '安全与降级' }], pass: 'all', maxRounds: 3, onExhausted: 'human', humanSignoff: true, arbiter: { role: 'tech-lead', focus: '结论冲突时裁决' } }, REQ3_DESIGN('REQ-003'), 'in_review')
  }

  const R4 = 'run-20261104-0004'
  if (db.runs.has(R4)) {
    convert(R4, 'review-spec', 'PRD 评审', { target: ['spec/spec.md'], author: 'pm', reviewers: [{ role: 'test-designer' }], pass: 'all', maxRounds: 3, onExhausted: 'human', humanSignoff: false, stopAfterNoProgress: 2 }, REQ4_SPEC('REQ-004'), 'passed')
  }

  // REQ-007（quick-fix）的代码评审：第 1 修订第 1 轮进行中，还没有记录
  const R7 = 'run-20261106-0007'
  if (db.runs.has(R7)) reviews.push({ runId: R7, nodeId: 'code-review', title: '代码评审', config: { target: { code: { repo: 'shop-api' } }, author: 'dev', reviewers: [{ role: 'reviewer', focus: '时区与回退' }], pass: 'all', maxRounds: 2, onExhausted: 'human', humanSignoff: false, stopAfterNoProgress: 2 }, rounds: [], status: 'in_review', reworks: 0, dispositions: [] })

  function latestVersion(path: string, ws: string): number | undefined {
    const rec = db.artifacts.get(ws)?.find((a) => a.path === path)
    return rec?.versions[rec.versions.length - 1]?.version
  }

  /** 正交状态：阶段、结论、覆盖、新鲜度、未关闭问题分别给出。 */
  function facets(r: MockReview): ReviewFacets {
    const last = r.rounds[r.rounds.length - 1]
    const ws = db.runs.get(r.runId)?.state.requirementId ?? ''
    const phase: ReviewFacets['phase'] =
      r.status === 'passed' ? 'done' : r.status === 'exhausted' ? 'exhausted' : r.status === 'reworked' ? 'reworked' : r.status === 'revising' ? 'revising' : r.status === 'pending' ? 'pending' : last?.passed && r.config.humanSignoff ? 'signoff' : 'reviewing'
    const issues = last?.records.flatMap((x) => x.issues) ?? []
    const outcome: ReviewFacets['outcome'] = !last ? undefined : last.passed ? (issues.length ? 'approved' : 'no_findings') : last.records.some((x) => x.verdict === 'reject') ? 'rejected' : 'changes_requested'
    const refs = last?.records.flatMap((x) => x.artifacts) ?? []
    const freshness: ReviewFacets['freshness'] = !last ? 'unknown' : refs.some((a) => a.version !== undefined && (latestVersion(a.path, ws) ?? 0) > a.version) ? 'stale' : refs.length ? 'current' : 'unknown'
    const open = { blocker: 0, major: 0, minor: 0, nit: 0 }
    const seen = new Set<string>()
    for (const i of issues) {
      const key = i.groupKey ?? i.id
      if (seen.has(key)) continue
      seen.add(key)
      const fixed = last!.responses.some((p) => p.issueId === i.id && p.action === 'fixed')
      const d = [...r.dispositions].reverse().find((x) => x.groupKey === key)
      const closed = d ? d.state !== 'open' && d.fingerprint === i.fingerprint : fixed
      if (!closed) open[i.severity]++
    }
    const observed: NonNullable<ReviewFacets['observed']> = {}
    for (const c of last?.continuity ?? []) {
      observed[c.observation] = (observed[c.observation] ?? 0) + 1
      if (c.regressed) observed.regressed = (observed.regressed ?? 0) + 1
    }
    const reviewers = new Set(r.config.reviewers.map((x) => x.role))
    const coverage = last && [...reviewers].every((role) => last.records.some((x) => x.reviewer === role)) ? 'full' : 'partial'
    return { phase, outcome, coverage, freshness, open, observed: last?.continuity ? observed : undefined }
  }

  return {
    list: (requirementId) =>
      reviews
        .filter((r) => db.runs.get(r.runId)?.state.requirementId === requirementId)
        .map((r): ReviewSummary => {
          const last = r.rounds[r.rounds.length - 1]
          return {
            runId: r.runId,
            nodeId: r.nodeId,
            title: r.title,
            target: r.config.target,
            status: r.status,
            round: last?.round ?? 0,
            maxRounds: r.config.maxRounds,
            reworks: r.reworks,
            latest: (last?.records ?? []).map((x) => ({ reviewer: x.reviewer, verdict: x.verdict, score: x.score, openIssues: x.issues.filter((i) => !last!.responses.some((p) => p.issueId === i.id && p.action === 'fixed')).length })),
            revision: last?.revision ?? 1,
            facets: facets(r),
          }
        }),
    detail: (runId, nodeId) => {
      const r = reviews.find((x) => x.runId === runId && x.nodeId === nodeId)
      return r && { config: r.config, rounds: r.rounds, status: r.status, facets: facets(r), dispositions: r.dispositions }
    },
    dispose(runId, nodeId, body) {
      const r = reviews.find((x) => x.runId === runId && x.nodeId === nodeId)
      if (!r) return `评审节点 ${nodeId} 不存在`
      if (!body.reason.trim()) return '处置需要写原因'
      const issue = r.rounds.flatMap((x) => x.records.flatMap((y) => y.issues)).reverse().find((i) => i.groupKey === body.groupKey)
      if (!issue) return `问题 ${body.groupKey} 不存在`
      const d: ReviewDisposition = { groupKey: body.groupKey, state: body.state, reason: body.reason, by: { type: 'human', id: 'web' }, at: new Date().toISOString(), fingerprint: issue.fingerprint }
      r.dispositions.push(d)
      const run = db.runs.get(runId)
      if (run) insertEvents(run, [{ ts: d.at, nodeId, type: 'review.disposition', actor: d.by, data: d }])
      return d
    },
  }
}
