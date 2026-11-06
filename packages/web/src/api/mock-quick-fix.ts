/**
 * T1 需求走 quick-fix（docs/design/19 §1）：REQ-007 导出文件名改用本地日期。
 * 短 spec → 实现（带完成标准自检）→ 代码评审（运行中）→ 交付校验。
 */
import type { Actor, ArtifactRecord, EventEnvelope, EventPayloads, EventType, GraphNode, NodeState, Requirement, StageDef } from '@taktflow/core'
import type { MockDb, MockRun, TplNode } from './mock-data'
import { routeOf, seedRoutes } from './mock-route'

const MIN = 60_000
export const QUICK_RUN = 'run-20261106-0007'
const REQ = 'REQ-007'
const ENGINE: Actor = { type: 'system', id: 'engine' }
const PM: Actor = { type: 'agent', role: 'pm', harness: 'claude-code', model: 'sonnet' }
const DEV: Actor = { type: 'agent', role: 'dev', harness: 'codex', model: 'gpt-5-codex' }
const REVIEWER: Actor = { type: 'agent', role: 'reviewer', harness: 'claude-code', model: 'sonnet' }
const STAGES: StageDef[] = [
  { id: 'spec', title: '短 spec' },
  { id: 'build', title: '实现与评审' },
  { id: 'verify', title: '交付校验' },
]

const SPEC = `# Spec：导出文件名改用本地日期

- **改动面**：shop-api \`src/export/filename.ts\`（单一改动面，T1）
- **现状**：文件名用 UTC 日期，北京时间 0–8 点导出的文件日期是前一天。
- AC-1 文件名格式 \`orders-YYYYMMDD-HHmm.csv\`，日期取用户所在时区
- AC-2 缺少时区信息时回退到 Asia/Shanghai
`

export const QUICK_COMPLETION = ['文件名按用户时区生成，格式 orders-YYYYMMDD-HHmm.csv', '缺少时区时回退到 Asia/Shanghai', '新增单测覆盖 0–8 点跨日场景且全部通过']

const TPL: TplNode[] = [
  { id: 'spec', kind: 'agent', title: '短 spec', stage: 'spec', needs: [], role: 'pm', goal: '把需求写成两条可验证的 AC', owner: 'pm', outputs: [{ path: 'spec/spec.md', kind: 'spec' }] },
  { id: 'implement', kind: 'agent', title: '实现', stage: 'build', needs: ['spec'], role: 'dev', goal: '文件名日期改为用户时区，补跨日单测', owner: 'rd', completion: QUICK_COMPLETION, inputs: ['spec/spec.md'], prompt: '只改 src/export/filename.ts 与对应单测；写权限 src/export/filename.ts、test/export/**。' },
  { id: 'code-review', kind: 'review', title: '代码评审', stage: 'build', needs: ['implement'], role: 'reviewer', goal: '确认时区处理与回退逻辑正确', owner: 'rd' },
  { id: 'acceptance', kind: 'gate', title: '交付校验', stage: 'verify', needs: ['code-review'], goal: '每条 AC 有用例、最近一次执行通过、有证据', owner: 'qa', checks: [{ id: 'acceptance', kind: 'acceptance', title: '交付校验（verifier 复核）' }] },
]

export function addQuickFix(db: MockDb): void {
  if (db.requirements.some((r) => r.id === REQ) || !db.requirements.length) return
  const start = Date.now() - 26 * MIN
  const at = (m: number) => new Date(start + m * MIN).toISOString()
  const req: Requirement = { id: REQ, title: '导出文件名改用本地日期', status: 'active', owner: 'chen', members: ['chen', 'lin'], links: [], createdAt: at(-6), updatedAt: at(18) }
  db.requirements.push(req)

  const specRec: ArtifactRecord = {
    path: 'spec/spec.md', kind: 'spec', title: 'Spec（短）', mediaType: 'text/markdown', tags: ['quick-fix'], traceIds: ['AC-1', 'AC-2'],
    versions: [{ version: 1, sha256: 'd'.repeat(64), size: SPEC.length, createdAt: at(3), author: PM, reason: '短 spec', derivedFrom: [], producedBy: { runId: QUICK_RUN, nodeId: 'spec' } }],
  }
  db.artifacts.set(REQ, [specRec])
  db.contents.set(`${REQ}:spec/spec.md@1`, { content: SPEC, mediaType: 'text/markdown' })

  const usage = (i: number, o: number, c: number) => ({ inputTokens: i, outputTokens: o, cachedTokens: Math.round(i * 0.4), costUsd: c })
  const states: Record<string, NodeState> = {
    spec: { id: 'spec', status: 'succeeded', attempts: 1, startedAt: at(0.3), endedAt: at(3), outputs: [{ workspace: REQ, path: 'spec/spec.md', version: 1 }], usage: usage(8_200, 1_100, 0.031), summary: '两条 AC：按用户时区生成日期；缺时区回退上海' },
    implement: {
      id: 'implement', status: 'succeeded', attempts: 1, startedAt: at(3.2), endedAt: at(17.5), inputs: [{ workspace: REQ, path: 'spec/spec.md', version: 1 }], outputs: [], usage: usage(41_600, 5_200, 0.118),
      worktree: { repo: 'shop-api', path: `.takt/worktrees/${QUICK_RUN}/implement`, branch: 'quick/export-filename-tz', base: 'main' },
      summary: 'filename.ts 改用 Intl 按时区格式化，新增 4 条单测全部通过',
      checks: [
        { id: 'c1', criterion: QUICK_COMPLETION[0]!, pass: true, evidence: 'src/export/filename.ts:12 formatInTimeZone(now, tz, "yyyyMMdd-HHmm")' },
        { id: 'c2', criterion: QUICK_COMPLETION[1]!, pass: true, evidence: 'src/export/filename.ts:9 tz ?? "Asia/Shanghai"；单测 fallback-tz' },
        { id: 'c3', criterion: QUICK_COMPLETION[2]!, pass: true, evidence: 'npm test -- filename → 4 passed（含 00:30 / 07:59 跨日）' },
      ],
    },
    'code-review': { id: 'code-review', status: 'running', attempts: 1, startedAt: at(17.6), outputs: [], revision: 1, round: 1 },
    acceptance: { id: 'acceptance', status: 'pending', attempts: 0, outputs: [] },
  }
  const graph: GraphNode[] = TPL.map((t) => ({
    id: t.id, kind: t.kind, title: t.title, stage: t.stage, status: states[t.id]!.status, role: t.role,
    harness: t.role === 'dev' ? 'codex' : t.role ? 'claude-code' : undefined, attempts: states[t.id]!.attempts,
    usage: states[t.id]!.usage, goal: t.goal, summary: states[t.id]!.summary,
    ...(t.kind === 'review' ? { revision: 1, round: 1, reworks: 0 } : {}),
  }))
  const seed = seedRoutes()[REQ]!
  const route = routeOf(seed.tier, { ...seed, at: at(0.1) })
  const run: MockRun = {
    state: { runId: QUICK_RUN, workflowId: 'quick-fix', workflowVersion: '0.1.0', requirementId: REQ, status: 'running', startedAt: at(0), args: {}, nodes: states, expansions: [], kind: 'workflow', route, budget: { tokens: 160_000, costUsd: 1.5, minutes: 60 } },
    workflow: { id: 'quick-fix', title: '快速修复', version: '0.1.0', stages: STAGES },
    graph: { nodes: graph, edges: TPL.slice(1).map((t) => ({ from: t.needs[0]!, to: t.id, kind: 'dep' as const })) },
    events: [],
    tpl: new Map(TPL.map((t) => [t.id, t])),
    context: new Map(),
    prompts: new Map([['implement', TPL[1]!.prompt!]]),
    gates: {},
    live: ['code-review'],
    quality: { verified: 3, intercepted: 0, interceptedBy: { gate: 0, review: 0, judge: 0, completion: 0, fingerprint: 0 } },
  }
  const ev = <T extends EventType>(m: number, type: T, actor: Actor, data: EventPayloads[T], nodeId?: string) => {
    const prev = run.events[run.events.length - 1]
    const seq = (prev?.seq ?? 0) + 1
    const prevHash = prev?.hash ?? '0'.repeat(64)
    run.events.push({ seq, ts: at(m), runId: QUICK_RUN, nodeId, type, actor, data, prevHash, hash: (prevHash.slice(8) + seq.toString(16).padStart(8, '0')).slice(-64) } as EventEnvelope)
  }
  ev(0, 'run.started', ENGINE, { workflowId: 'quick-fix', workflowVersion: '0.1.0', args: {} })
  ev(0.1, 'route.decided', route.decidedBy, route)
  ev(0.3, 'node.started', PM, { attempt: 1 }, 'spec')
  ev(3, 'artifact.written', PM, { ref: { workspace: REQ, path: 'spec/spec.md', version: 1 }, kind: 'spec', sha256: 'd'.repeat(64) }, 'spec')
  ev(3, 'node.finished', PM, { status: 'succeeded', outputs: states.spec!.outputs, usage: states.spec!.usage }, 'spec')
  ev(3.2, 'worktree.created', ENGINE, { repo: 'shop-api', path: states.implement!.worktree!.path, branch: 'quick/export-filename-tz', base: 'main' }, 'implement')
  ev(3.9, 'worktree.bootstrapped', ENGINE, { repo: 'shop-api', path: states.implement!.worktree!.path, command: 'npm ci && npm run db:migrate -- --env test', shared: ['node_modules', '.cache/prisma'], ok: true, ms: 41_200 }, 'implement')
  ev(4, 'lesson.recalled', ENGINE, { ids: ['L-003'], holdout: false, tokens: 180 }, 'implement')
  ev(4, 'node.started', DEV, { attempt: 1 }, 'implement')
  ev(17.4, 'node.checks', DEV, { checks: states.implement!.checks!, unmet: [] }, 'implement')
  ev(17.5, 'node.finished', DEV, { status: 'succeeded', outputs: [], usage: states.implement!.usage }, 'implement')
  ev(17.6, 'node.started', REVIEWER, { attempt: 1 }, 'code-review')
  db.runs.set(QUICK_RUN, run)
}
