import type { ArtifactContent, CheckpointDetail, CheckpointRole, GateCheckResult, Invocation, NodeDetail, ReviewIssueEntry, ReviewRecord, SnapshotManifest } from '@taktflow/core'
import type { MockDb, MockRun } from './mock-data'

/**
 * M5 演示数据：检查点、只读快照、调用身份三层取值、问题键台账（docs/design/21 §1–3）。
 * 从演示评审轮次与门禁结果推导；扮演 server 的 insights/node-quality。
 */

const hash = (s: string) => [...s].reduce((h, c) => (Math.imul(h, 31) + c.charCodeAt(0)) >>> 0, 7)
const hex = (s: string, n = 64) => Array.from({ length: Math.ceil(n / 8) }, (_, i) => hash(`${s}:${i}`).toString(16).padStart(8, '0')).join('').slice(0, n)
const shift = (at: string, ms: number) => new Date(Date.parse(at) + ms).toISOString()

const HARNESS: Record<string, string> = { pm: 'claude-code', architect: 'claude-code', reviewer: 'claude-code', 'test-designer': 'codex', 'tech-lead': 'claude-code', dev: 'codex', judge: 'claude-code' }

/** 比较依据：评审时一起放进快照的上游产物。 */
const REFERENCES: Array<[RegExp, string[]]> = [
  [/^review-spec$/, ['inputs/prd.md']],
  [/^review-design$/, ['spec/spec.md']],
  [/^review-cases$/, ['spec/spec.md', 'design/contracts.json']],
  [/\/review$/, ['spec/spec.md', 'design/design.md']],
]

/** 职责条目：演示用，按评审者角色给 3–4 条。 */
const DUTIES: Record<string, string[]> = {
  pm: ['每条验收标准都可验证', '范围与 PRD 一致，没有遗漏或越界', '异常与边界场景写明预期'],
  architect: ['契约字段与 spec 一致', '错误码与降级路径完整', '数据影响与回滚步骤明确'],
  'test-designer': ['每条 AC 至少一条用例', '边界值与异常输入有覆盖', '断言落到业务字段，而不只是状态码'],
  reviewer: ['实现逐条对照 spec 的 AC', '边界与错误处理', '单测覆盖新增分支', '没有越界改动'],
  'tech-lead': ['冲突结论给出取舍依据'],
}

/** 只读方式按节点演示三种情况：沙箱只读挂载、文件权限、做不到。 */
function readOnlyOf(nodeId: string): SnapshotManifest['readOnly'] {
  if (nodeId === 'review-spec') return 'sandbox'
  if (nodeId.endsWith('/review')) return 'none'
  return 'permissions'
}

function invocation(run: MockRun, nodeId: string, checkpointId: string, role: CheckpointRole, agentRole: string, at: string, ms: number, idx = 0): Invocation {
  const harness = HARNESS[agentRole] ?? 'claude-code'
  const claude = harness === 'claude-code'
  const model = claude ? 'claude-sonnet-4.5' : 'gpt-5-codex'
  const id = `inv-${hex(checkpointId + idx, 10)}`
  return {
    id,
    nodeId,
    attempt: 1,
    checkpointId,
    role,
    agentRole,
    fallbackIndex: idx,
    recipeKey: `${agentRole}@${hex(agentRole, 6)}`,
    harness,
    // claude-code 能回报实际模型且支持覆盖；codex 这里演示"没回报、不确定是否生效"
    model: claude ? { requested: model, resolved: model, reported: 'claude-sonnet-4-5-20250929', applied: true } : { requested: model, resolved: model },
    effort: claude ? { requested: 'high', resolved: 'high', applied: false } : { requested: 'high', resolved: 'high', reported: 'high', applied: true },
    skills: [
      { name: `${agentRole}-checklist`, providedHash: hex(`${agentRole}-skill`, 12), confirmed: claude ? 'yes' : 'unknown' },
      ...(run.state.requirementId === 'REQ-002' ? [{ name: 'csv-export', providedHash: hex('csv-export', 12), confirmed: claude ? ('yes' as const) : ('unknown' as const) }] : []),
    ],
    readOnly: role === 'reviewer' || role === 'arbiter' || role === 'rubric',
    at,
    outcome: 'ok',
    durationMs: ms,
    usage: { inputTokens: 18_000 + (hash(id) % 20) * 1000, outputTokens: 1_200 + (hash(id) % 9) * 150, cachedTokens: 6_000, costUsd: 0.09 + (hash(id) % 10) / 100 },
    sessionId: `${claude ? 'cc' : 'cx'}-${hex(id, 12)}`,
    reported: claude ? { model: 'claude-sonnet-4-5-20250929', skills: [`${agentRole}-checklist`] } : undefined,
  }
}

export interface MockChecks {
  decorate(run: MockRun, nodeId: string, detail: NodeDetail): void
  snapshot(run: MockRun, checkpointId: string): SnapshotManifest | undefined
  snapshotFile(run: MockRun, checkpointId: string, path: string): ArtifactContent | undefined
}

export function createMockChecks(db: MockDb): MockChecks {
  const manifests = new Map<string, SnapshotManifest>()

  function manifest(run: MockRun, nodeId: string, cp: string, record: ReviewRecord, duties: string[], at: string): SnapshotManifest {
    const refs = REFERENCES.find(([re]) => re.test(nodeId))?.[1] ?? []
    const ws = run.state.requirementId
    const latest = (path: string) => {
      const rec = db.artifacts.get(ws)?.find((a) => a.path === path)
      const vs = rec?.versions.filter((v) => Date.parse(v.createdAt) <= Date.parse(at))
      return vs?.length ? vs[vs.length - 1]!.version : rec?.versions[0]?.version
    }
    const file = (path: string, version: number | undefined, role: 'target' | 'reference') => {
      const content = version ? (db.contents.get(`${ws}:${path}@${version}`)?.content ?? '') : ''
      return { path: `${role === 'target' ? 'target' : 'ref'}/${path}`, role, source: 'artifact' as const, ref: { workspace: ws, path, version }, sha256: hex(`${path}@${version}`), size: content.length }
    }
    const code = nodeId.endsWith('/review')
    const files = [
      ...(code
        ? [{ path: 'target/changes.diff', role: 'target' as const, source: 'diff' as const, repo: 'app', commit: hex(`${nodeId}:head`, 7), sha256: hex(`${nodeId}:diff`), size: 1840 }]
        : record.artifacts.map((r) => file(r.path, r.version, 'target'))),
      ...refs.map((p) => file(p, latest(p), 'reference')),
    ]
    const m: SnapshotManifest = { checkpointId: cp, dir: `snapshots/${run.state.runId}/${cp.replaceAll(':', '_').replaceAll('/', '__')}`, files, duties, readOnly: readOnlyOf(nodeId), createdAt: shift(at, -90_000) }
    manifests.set(cp, m)
    return m
  }

  /** 问题台账：按 groupKey 分配 ISS 键，作者 fixed → claimed_fixed，下一轮评审者没再提 → verified_fixed。 */
  function ledger(detail: NonNullable<NodeDetail['review']>): ReviewIssueEntry[] {
    const byGroup = new Map<string, ReviewIssueEntry>()
    let n = 0
    const rounds = detail.rounds
    rounds.forEach((r, ri) => {
      const revision = r.revision ?? 1
      for (const rec of r.records) {
        const prevKeys: NonNullable<ReviewRecord['previous']> = []
        // 之前轮次提出、还没关闭的问题：这一轮由提出者逐键复查（引擎把未关闭的键列进评审 prompt）
        for (const e of byGroup.values()) {
          if ((e.status !== 'claimed_fixed' && e.status !== 'open') || e.raisedBy !== rec.reviewer) continue
          if (e.last.revision === revision && e.last.round === r.round) continue
          const again = rec.issues.some((i) => (i.groupKey ?? i.id) === e.groupKey)
          // 演示 not_checked：REQ-003 系分评审第 2 轮的 test-designer 没给复查结论
          const skip = ri === rounds.length - 1 && rec.reviewer === 'test-designer' && rounds.length > 1
          const status = skip ? 'not_checked' : again ? 'still_open' : 'resolved'
          prevKeys.push({ key: e.key, status, note: status === 'resolved' ? '已对照新版本确认' : status === 'still_open' ? '新版本仍有同样问题' : undefined })
          e.history.push({ revision, round: r.round, action: status === 'resolved' ? 'verified_fixed' : status, by: rec.reviewer, at: rec.at })
          if (status === 'resolved') e.status = 'verified_fixed'
          else if (status === 'still_open') e.status = 'open'
          e.last = { revision, round: r.round, checkpointId: rec.checkpointId }
        }
        if (prevKeys.length) rec.previous = prevKeys
        for (const i of rec.issues) {
          const g = i.groupKey ?? i.id
          let e = byGroup.get(g)
          if (!e) {
            e = { key: `ISS-${++n}`, title: i.title ?? i.description.slice(0, 32), severity: i.severity, location: i.location, status: 'open', raisedBy: rec.reviewer, groupKey: g, duty: i.duty, first: { revision, round: r.round, checkpointId: rec.checkpointId }, last: { revision, round: r.round, checkpointId: rec.checkpointId }, history: [{ revision, round: r.round, action: 'raised', by: rec.reviewer, at: rec.at }] }
            byGroup.set(g, e)
          } else if (e.history[e.history.length - 1]?.round !== r.round || e.history[e.history.length - 1]?.revision !== revision) {
            e.history.push({ revision, round: r.round, action: 'reobserved', by: rec.reviewer, at: rec.at })
          }
          i.key = e.key
        }
      }
      for (const p of r.responses) {
        const issue = r.records.flatMap((x) => x.issues).find((i) => i.id === p.issueId)
        const e = issue && byGroup.get(issue.groupKey ?? issue.id)
        if (!e) continue
        p.key = e.key
        if (p.action === 'fixed') {
          e.status = 'claimed_fixed'
          e.history.push({ revision, round: r.round, action: 'claimed_fixed', by: p.reviewer, note: p.note, at: shift(r.records[0]!.at, 60_000) })
        }
      }
    })
    for (const d of detail.dispositions ?? []) {
      const e = byGroup.get(d.groupKey)
      if (!e || d.state === 'open') continue
      e.status = d.state === 'dismissed' ? 'dismissed' : 'waived'
      e.history.push({ revision: e.last.revision, round: e.last.round, action: e.status, by: d.by.type === 'human' ? d.by.id : 'system', note: d.reason, at: d.at })
    }
    return [...byGroup.values()]
  }

  function reviewCheckpoints(run: MockRun, nodeId: string, detail: NodeDetail): { cps: CheckpointDetail[]; invs: Invocation[] } {
    const rv = detail.review!
    const cps: CheckpointDetail[] = []
    const invs: Invocation[] = []
    const base = `${run.state.runId}:${nodeId}:1`
    for (const r of rv.rounds) {
      const rr = `${r.revision ?? 1}.${r.round}`
      for (const rec of r.records) {
        const id = `${base}:${rr}:${rec.reviewer}`
        const duties = DUTIES[rec.reviewer] ?? []
        rec.checkpointId = id
        rec.checklist ??= duties.map((item, k) => {
          const issues = rec.issues.filter((_, j) => j % Math.max(1, duties.length) === k)
          return { item, status: issues.length ? 'issue' : k === duties.length - 1 && rec.reviewer === 'reviewer' ? 'na' : 'ok', issues: issues.map((i) => i.id), note: issues.length ? undefined : k === duties.length - 1 && rec.reviewer === 'reviewer' ? '本次改动没有新增分支' : undefined }
        })
        for (const [k, i] of rec.issues.entries()) i.duty ??= duties[k % Math.max(1, duties.length)]
        const inv = invocation(run, nodeId, id, rec.arbiter ? 'arbiter' : 'reviewer', rec.reviewer, shift(rec.at, -150_000), 140_000 + (hash(id) % 60) * 1000)
        rec.invocationId = inv.id
        invs.push(inv)
        cps.push({ id, runId: run.state.runId, nodeId, attempt: 1, revision: r.revision ?? 1, round: r.round, role: rec.arbiter ? 'arbiter' : 'reviewer', subject: rec.reviewer, duties, scheduledAt: shift(rec.at, -160_000), status: 'done', endedAt: rec.at, snapshot: manifest(run, nodeId, id, rec, duties, rec.at), invocations: [inv.id], record: rec })
      }
      // 没执行的评审者也有身份：运行中的显示"排队"，之前轮次缺席的演示"跳过"
      const last = r === rv.rounds[rv.rounds.length - 1]
      for (const cfg of rv.config.reviewers) {
        if (r.records.some((x) => x.reviewer === cfg.role)) continue
        const id = `${base}:${rr}:${cfg.role}`
        const at = r.records[0]?.at ?? run.state.startedAt
        cps.push({ id, runId: run.state.runId, nodeId, attempt: 1, revision: r.revision ?? 1, round: r.round, role: 'reviewer', subject: cfg.role, duties: DUTIES[cfg.role], scheduledAt: shift(at, -160_000), status: last && rv.status === 'in_review' ? 'scheduled' : 'skipped', error: last && rv.status === 'in_review' ? undefined : '前一位评审者调用出错，本轮中止，没有执行', invocations: [] })
      }
      if (r.responses.length) {
        const id = `${base}:${rr}:author`
        const author = rv.config.author ?? 'author'
        const inv = invocation(run, nodeId, id, 'author', author, shift(r.records[0]!.at, 10_000), 50_000)
        invs.push(inv)
        cps.push({ id, runId: run.state.runId, nodeId, attempt: 1, revision: r.revision ?? 1, round: r.round, role: 'author', subject: author, scheduledAt: shift(r.records[0]!.at, 5_000), status: 'done', endedAt: shift(r.records[0]!.at, 60_000), invocations: [inv.id] })
      }
    }
    // REQ-001 系分评审第 1 轮：演示"跳过"（后来补上的那位评审者在本轮没执行）
    if (nodeId === 'review-design' && run.state.runId === 'run-20261104-0001' && !cps.some((c) => c.status === 'skipped')) {
      const r1 = rv.rounds[0]
      if (r1) cps.splice(r1.records.length, 0, { id: `${base}:${r1.revision ?? 1}.${r1.round}:security`, runId: run.state.runId, nodeId, attempt: 1, revision: r1.revision ?? 1, round: r1.round, role: 'reviewer', subject: 'security', duties: ['鉴权与越权', '敏感字段脱敏'], scheduledAt: shift(r1.records[0]!.at, -160_000), status: 'skipped', error: '前一位评审者（reviewer）调用超时，本轮中止，没有执行', invocations: [] })
    }
    return { cps, invs }
  }

  function gateCheckpoints(run: MockRun, nodeId: string, detail: NodeDetail): CheckpointDetail[] {
    const g = detail.gate
    if (!g) return []
    // 演示门禁三态：REQ-004 系分门禁多一项命令检查，检查本身起不来（error，不算系分有问题）
    if (run.state.runId === 'run-20261104-0004' && nodeId === 'design-gate' && !g.checks.some((c) => c.id === 'contract-lint'))
      g.checks.push({ id: 'contract-lint', pass: false, status: 'error', message: 'npx spectral lint 启动失败：ENOENT（检查本身出错，不代表契约有问题）' })
    const kinds = new Map((detail.checks ?? []).map((c) => [c.id, c.kind]))
    const at = detail.state.endedAt ?? detail.state.startedAt ?? run.state.startedAt
    return g.checks.map((c: GateCheckResult) => {
      const status = c.status ?? (c.pass ? 'pass' : 'fail')
      c.status = status
      const kind = kinds.get(c.id)
      const role: CheckpointRole = kind === 'rubric' ? 'rubric' : kind === 'function' ? 'acceptance' : 'command'
      const id = `${run.state.runId}:${nodeId}:${detail.state.attempts || 1}:1.1:${c.id}`
      c.checkpointId = id
      return { id, runId: run.state.runId, nodeId, attempt: detail.state.attempts || 1, role, subject: c.id, duties: kind === 'rubric' ? ['契约完整', '方案说明分片与降级', '风险与回滚步骤'] : [c.id], scheduledAt: shift(at, -30_000), status: status === 'error' ? 'error' : 'done', error: status === 'error' ? c.message : undefined, endedAt: at, invocations: [], gate: c }
    })
  }

  return {
    decorate(run, nodeId, detail) {
      if (detail.review) {
        const { cps, invs } = reviewCheckpoints(run, nodeId, detail)
        detail.issues = ledger(detail.review)
        detail.checkpoints = cps
        detail.invocations = invs
      } else if (detail.gate) {
        detail.checkpoints = gateCheckpoints(run, nodeId, detail)
      } else if ((detail.kind === 'agent' || detail.kind === 'judge' || detail.kind === 'planner') && detail.state.startedAt) {
        const role: CheckpointRole = detail.kind === 'judge' ? 'judge' : detail.kind === 'planner' ? 'planner' : 'producer'
        const id = `${run.state.runId}:${nodeId}:${detail.state.attempts || 1}:1.1:${detail.role ?? detail.kind}`
        const ms = detail.state.endedAt ? Date.parse(detail.state.endedAt) - Date.parse(detail.state.startedAt) : 0
        detail.invocations = [invocation(run, nodeId, id, role, detail.role ?? 'dev', detail.state.startedAt, ms)]
        if (!detail.state.endedAt) {
          const inv = detail.invocations[0]!
          delete inv.outcome
          delete inv.reported
          inv.durationMs = undefined
        }
      }
    },
    snapshot: (_run, cp) => manifests.get(cp),
    snapshotFile(run, cp, path) {
      const m = manifests.get(cp)
      const f = m?.files.find((x) => x.path === path)
      if (!m || !f) return undefined
      if (f.source === 'diff') return { path, version: 1, mediaType: 'text/x-diff', content: `diff --git a/src/greet.js b/src/greet.js\n--- a/src/greet.js\n+++ b/src/greet.js\n@@ -1,4 +1,6 @@\n export function greet(name) {\n-  return \`Hello, \${name}!\`\n+  const n = name.trim()\n+  if (!n) return 'Hello, friend!'\n+  return \`Hello, \${name}!\`\n }`, encoding: 'utf8' }
      const content = f.ref?.version ? db.contents.get(`${run.state.requirementId}:${f.ref.path}@${f.ref.version}`) : undefined
      return { path, version: f.ref?.version ?? 1, mediaType: content?.mediaType ?? 'text/markdown', content: content?.content ?? '', encoding: 'utf8' }
    },
  }
}
