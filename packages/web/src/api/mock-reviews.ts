/**
 * 评审演示数据（贴近 examples/standard-delivery）：把运行演示数据里的评审节点换成 review 节点并补上轮次记录。
 * - REQ-001：PRD 第 1 轮要求修改、第 2 轮通过；系分连续 3 轮不通过 → 打回重新设计一次 → 第 4 轮通过；两个任务的代码评审 1 轮通过；
 * - REQ-003：系分评审第 1 轮 agent 全部通过，等人确认。
 * 轮次编号跨打回连续递增（1..4）；ReviewSummary.round 是本次打回之后的轮次。
 */
import type { Actor, ArtifactRef, EventEnvelope, EventPayloads, EventType, NodeDetail, ReviewIssue, ReviewRecord, ReviewResponse, ReviewRound, ReviewStatus, ReviewSummary, ReviewVerdict } from '@taktflow/core'
import * as C from './mock-content'
import type { MockDb, MockRun } from './mock-data'

type ReviewView = NonNullable<NodeDetail['review']>
interface MockReview extends ReviewView {
  runId: string
  nodeId: string
  title: string
  reworks: number
}

const agent = (role: string): Actor => ({ type: 'agent', role, harness: role === 'test-designer' || role === 'dev' ? 'codex' : 'claude-code', model: role === 'dev' || role === 'test-designer' ? 'gpt-5-codex' : 'sonnet' })
const ENGINE: Actor = { type: 'system', id: 'engine' }
const issue = (id: string, severity: ReviewIssue['severity'], location: string, description: string, suggestion?: string): ReviewIssue => ({ id, severity, location, description, suggestion })
const rec = (reviewer: string, verdict: ReviewVerdict, score: number, summary: string, issues: ReviewIssue[] = []) => ({ reviewer, verdict, score, summary, issues })
const resp = (issueId: string, reviewer: string, action: ReviewResponse['action'], note: string) => ({ issueId, reviewer, action, note })

interface RoundSpec {
  records: Array<Omit<ReviewRecord, 'round' | 'artifacts' | 'at'>>
  responses?: Array<Omit<ReviewResponse, 'round'>>
  /** 本轮评审看到的产物版本。 */
  sees: ArtifactRef[]
  revised?: ArtifactRef[]
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
        rec('test-designer', 'request_changes', 62, '契约没有说明 null / undefined 的行为。', [issue('D1-T1', 'major', 'design/contracts.json#greet', '入参为 null 或 undefined 时的返回值未定义，用例无从断言。', '契约里写明：非字符串一律视为空名字。')]),
        rec('reviewer', 'request_changes', 70, '方案直接 trim 输入，会改变存量输出。', [issue('D1-R1', 'blocker', 'design/design.md#方案', 'greet() 先 trim 再拼接，"  bob  " 的输出会从 "Hello,   bob  !" 变成 "Hello, bob!"，存量调用方有快照测试。', 'trim 只用于判空，输出保留原值。')]),
      ],
      responses: [resp('D1-T1', 'test-designer', 'fixed', '契约补充非字符串入参。'), resp('D1-R1', 'reviewer', 'fixed', '改为 trim 后判空。')],
      revised: d(2),
    },
    {
      sees: d(2),
      records: [
        rec('pm', 'approve', 86, '没有问题。'),
        rec('test-designer', 'approve', 80, '契约已可验证。'),
        rec('reviewer', 'request_changes', 74, '判空逻辑写在 CLI 和 HTTP 两个入口，没有收敛到 greet()。', [issue('D2-R1', 'major', 'design/design.md#改动范围', 'cli/hello.js 和 server/routes/greet.js 各自判空，两处规则容易漂移。', '判空只放在 greet() 内部，入口不做处理。')]),
      ],
      responses: [resp('D2-R1', 'reviewer', 'declined', 'HTTP 入口需要提前返回 400，保留入口判空。')],
      revised: d(3),
    },
    {
      sees: d(3),
      records: [
        rec('pm', 'approve', 85, '同意。'),
        rec('test-designer', 'approve', 82, '同意。'),
        rec('reviewer', 'request_changes', 66, '入口判空与 PRD 冲突：PRD 要求空名字返回问候语，不是 400。', [issue('D3-R1', 'blocker', 'design/design.md#HTTP 入口', 'HTTP 入口对空名字返回 400，与 AC-1 "返回 Hello, stranger!" 矛盾。', '回到上一轮的建议：只在 greet() 内判空。')]),
      ],
    },
    { sees: d(4), records: [rec('pm', 'approve', 90, '重新设计后范围更小。'), rec('test-designer', 'approve', 88, '契约与 AC 一一对应。'), rec('reviewer', 'approve', 91, '判空收敛到 greet()，入口不变，回归面最小。')] },
  ]
}

const CODE_ROUND = (ws: string, task: string, summary: string): RoundSpec[] => [{ sees: [{ workspace: ws, path: `tasks/${task}.md`, version: 1 }], records: [rec('reviewer', 'approve', 90, summary)] }]

const REQ3_DESIGN = (ws: string): RoundSpec[] => [
  {
    sees: [{ workspace: ws, path: 'design/design.md', version: 1 }],
    records: [
      rec('pm', 'approve', 83, '覆盖 AC-1～AC-3。'),
      rec('test-designer', 'approve', 80, '可测。', [issue('C1-T1', 'minor', 'design/contracts.json#errors', 'CAPTCHA_EXPIRED 与 NEED_CAPTCHA 的前端处理没区分。', '契约里写明前端分别如何提示。')]),
      rec('reviewer', 'approve', 78, '"Redis 不可用时不校验"属于安全取舍，需要人确认。', [issue('C1-R1', 'major', 'design/design.md#风险', 'Redis 降级为不校验会让撞库在故障期间不受限。', '降级时改为固定要求验证码，或交人决定。')]),
    ],
  },
]

/** 在 a、b 之间均匀取第 i 个时刻。 */
const lerp = (a: string | undefined, b: string | undefined, i: number, n: number) => {
  const s = Date.parse(a ?? new Date().toISOString())
  const e = b ? Date.parse(b) : s + n * 4 * 60_000
  return new Date(s + ((e - s) * (i + 1)) / (n + 1)).toISOString()
}

function buildRounds(run: MockRun, nodeId: string, specs: RoundSpec[]): ReviewRound[] {
  const st = run.state.nodes[nodeId]!
  return specs.map((s, i) => ({
    round: i + 1,
    passed: s.records.every((r) => r.verdict === 'approve'),
    records: s.records.map((r) => ({ ...r, round: i + 1, artifacts: s.sees, at: lerp(st.startedAt, st.endedAt, i, specs.length) })),
    responses: (s.responses ?? []).map((r) => ({ ...r, round: i + 1 })),
    revised: s.revised ?? [],
  }))
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
    const rounds = buildRounds(run, nodeId, specs)
    const reworks = rework ? 1 : 0
    const st = run.state.nodes[nodeId]!
    st.round = rework ? rounds.length - config.maxRounds : rounds.length
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
      if (rework && r.round === config.maxRounds) {
        const at = new Date(Date.parse(ts) + 30_000).toISOString()
        events.push({ ts: at, nodeId, type: 'review.exhausted', actor: ENGINE, data: { rounds: config.maxRounds, action: 'rework' } })
        events.push({ ts: at, nodeId, type: 'rework.started', actor: ENGINE, data: { from: nodeId, to: rework, count: 1, feedback: r.records.flatMap((x) => x.issues.map((i) => i.description)).join('\n'), reset: [rework, nodeId] } })
      }
    }
    insertEvents(run, events)
    reviews.push({ runId, nodeId, title, config, rounds, status, reworks })
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
    convert(R3, 'review-design', '系分交叉评审', { target: ['design/**'], author: 'architect', reviewers: [{ role: 'pm' }, { role: 'test-designer' }, { role: 'reviewer', focus: '安全与降级' }], pass: 'all', maxRounds: 3, onExhausted: 'human', humanSignoff: true }, REQ3_DESIGN('REQ-003'), 'in_review')
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
            round: r.reworks ? r.rounds.length - r.config.maxRounds * r.reworks : r.rounds.length,
            maxRounds: r.config.maxRounds,
            reworks: r.reworks,
            latest: (last?.records ?? []).map((x) => ({ reviewer: x.reviewer, verdict: x.verdict, score: x.score, openIssues: x.issues.filter((i) => !last!.responses.some((p) => p.issueId === i.id && p.action === 'fixed')).length })),
          }
        }),
    detail: (runId, nodeId) => {
      const r = reviews.find((x) => x.runId === runId && x.nodeId === nodeId)
      return r && { config: r.config, rounds: r.rounds, status: r.status }
    },
  }
}
