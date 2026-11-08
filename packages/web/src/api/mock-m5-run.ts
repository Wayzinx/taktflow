import type { EventEnvelope, EventPayloads, GraphNode, NodeActivity, NodeChanges, RewindPreview, RunTimeline } from '@taktflow/core'
import { lineDiff } from '../pages/workflow/collab/line-diff'
import type { MockDb, MockRun } from './mock-data'

/**
 * M5 演示数据：运行中细分、时间泳道与上下文曲线、节点改动卡与回退（docs/design/26）。
 * 全部从演示运行已有的事件推导，扮演 server 的 insights/activity|timeline|changes。
 */

const LOADED = Date.now()
const iso = (ms: number) => new Date(ms).toISOString()
const hash = (s: string) => [...s].reduce((h, c) => (Math.imul(h, 31) + c.charCodeAt(0)) >>> 0, 7)
const sha = (s: string) => (hash(s).toString(16) + hash(`${s}#`).toString(16)).padEnd(12, '0').slice(0, 12)

// ---------------------------------------------------------------- 运行中细分

/** 运行中的节点按这张表轮换，一圈 58 秒：其中"跑命令"和"等工具"超过 15 秒，演示长步骤。 */
const CYCLE: Array<Omit<NodeActivity, 'since'> & { sec: number }> = [
  { state: 'thinking', sec: 5 },
  { state: 'tool', tool: 'Read', input: 'evidence/TC-EXP-003/result.json', sec: 5 },
  { state: 'tool', tool: 'Bash', input: 'npm test -- TC-EXP-003', sec: 21 },
  { state: 'tool', tool: 'Grep', input: 'formatAmount', sec: 4 },
  { state: 'compacting', sec: 5 },
  { state: 'waiting_tool', tool: 'Edit', input: 'src/export/csv.ts', sec: 18 },
]
const CYCLE_SEC = CYCLE.reduce((s, c) => s + c.sec, 0)

export function mockActivity(nodeId: string, now = Date.now()): NodeActivity {
  // 不同节点错开相位，几个同时在跑时不会整齐划一
  let t = ((now - LOADED) / 1000 + (hash(nodeId) % CYCLE_SEC)) % CYCLE_SEC
  for (const c of CYCLE) {
    if (t < c.sec) {
      const { sec: _sec, ...rest } = c
      return { ...rest, since: iso(now - t * 1000) }
    }
    t -= c.sec
  }
  return { state: 'thinking', since: iso(now) }
}

// ---------------------------------------------------------------- 时间泳道

type Segment = RunTimeline['lanes'][number]['segments'][number]
type Lane = RunTimeline['lanes'][number]

const WINDOW: Record<string, number> = { 'claude-code': 200_000, codex: 272_000 }
/** 演示"窗口未知"：这个节点的 harness 没报上下文窗口。 */
const NO_WINDOW = 'automate'
/** 演示 fallback：首选 codex 中途出错，换 claude-code 接着做。 */
const FALLBACK = /\/csv-writer\/code$/

const evs = <T extends keyof EventPayloads>(list: EventEnvelope[], type: T) => list.filter((e) => e.type === type) as Array<EventEnvelope<T>>

function toolDuration(nodeId: string, seq: number): number {
  const h = hash(`${nodeId}:${seq}`)
  // 大约七分之一是长步骤
  return h % 7 === 0 ? 18_000 + (h % 24) * 1000 : 1500 + (h % 9) * 1500
}

function laneOf(run: MockRun, g: GraphNode, now: number): Lane {
  const list = run.events.filter((e) => e.nodeId === g.id)
  const segments: Segment[] = []
  let runStart: number | undefined
  let wait: { start: number; requestId: string } | undefined
  const human = g.kind === 'human'
  for (const e of list) {
    const ts = Date.parse(e.ts)
    if (e.type === 'node.started') runStart = ts
    else if ((e.type === 'node.finished' || e.type === 'node.failed') && runStart !== undefined) {
      if (!human) segments.push({ kind: 'run', start: iso(runStart), end: e.ts })
      runStart = undefined
    } else if (e.type === 'human.requested') wait = { start: ts, requestId: (e.data as EventPayloads['human.requested']).requestId }
    else if (e.type === 'human.answered' && wait) {
      segments.push({ kind: 'wait', start: iso(wait.start), end: e.ts, requestId: wait.requestId })
      wait = undefined
    }
  }
  const live = g.status === 'running' || g.status === 'waiting_human'
  const lastTs = list.length ? Date.parse(list[list.length - 1]!.ts) : now
  if (runStart !== undefined && !human) segments.push({ kind: 'run', start: iso(runStart), end: live ? undefined : iso(lastTs) })
  if (wait) segments.push({ kind: 'wait', start: iso(wait.start), end: g.status === 'waiting_human' ? undefined : iso(lastTs), requestId: wait.requestId })

  // 就绪未调度：上游都结束了，但本节点晚了 3 秒以上才开始
  const first = segments[0]
  if (first) {
    const deps = run.graph.edges.filter((e) => e.to === g.id && e.kind === 'dep').map((e) => run.state.nodes[e.from]?.endedAt)
    const ready = Math.max(...deps.map((d) => (d ? Date.parse(d) : 0)))
    const start = Date.parse(first.start)
    if (ready > 0 && start - ready > 3000) segments.unshift({ kind: 'queue', start: iso(ready), end: first.start })
  }

  // 调用：每个 harness.started 一次；fallback 节点拆成两次
  const runs = segments.filter((s) => s.kind === 'run')
  const spanEnd = (s: Segment) => (s.end ? Date.parse(s.end) : now)
  let invocations: Lane['invocations'] = evs(list, 'harness.started').map((e, i, all) => {
    const start = Date.parse(e.ts)
    const seg = runs.find((s) => Date.parse(s.start) <= start + 1000 && spanEnd(s) >= start) ?? runs[runs.length - 1]
    const next = all[i + 1]
    const end = next ? Date.parse(next.ts) : seg?.end ? Date.parse(seg.end) : undefined
    return { id: `inv-${sha(g.id + e.seq)}`, harness: e.data.harness, model: e.data.model, start: e.ts, end: end ? iso(end) : undefined, outcome: end ? (g.status === 'failed' && !next ? 'error' : 'ok') : undefined, attempt: i + 1, fallbackIndex: 0 }
  })
  if (FALLBACK.test(g.id) && invocations.length === 1) {
    const inv = invocations[0]!
    const start = Date.parse(inv.start)
    const cut = start + ((inv.end ? Date.parse(inv.end) : now) - start) * 0.36
    invocations = [
      { id: `${inv.id}-a`, harness: 'codex', model: 'gpt-5-codex', start: inv.start, end: iso(cut), outcome: 'error', attempt: 1, fallbackIndex: 0 },
      { id: `${inv.id}-b`, harness: 'claude-code', model: 'claude-sonnet-4.5', start: iso(cut), end: inv.end, outcome: inv.outcome, attempt: 1, fallbackIndex: 1 },
    ]
  }
  const invAt = (ms: number) => [...invocations].reverse().find((v) => Date.parse(v.start) <= ms)?.id

  for (const e of evs(list, 'harness.tool_call')) {
    const end = Date.parse(e.ts)
    const seg = runs.find((s) => Date.parse(s.start) <= end && spanEnd(s) >= end)
    const start = Math.max(seg ? Date.parse(seg.start) : end - 1000, end - toolDuration(g.id, e.seq))
    segments.push({ kind: 'tool', start: iso(start), end: e.ts, tool: e.data.tool, input: e.data.input, ok: e.data.ok, invocationId: invAt(end), long: end - start >= 15_000 })
  }
  if (g.status === 'running' && (g.kind === 'agent' || g.kind === 'judge')) {
    const a = mockActivity(g.id, now)
    if (a.state === 'tool' || a.state === 'waiting_tool') segments.push({ kind: 'tool', start: a.since, tool: a.tool, input: a.input, invocationId: invAt(now), long: now - Date.parse(a.since) >= 15_000 })
    if (a.state === 'compacting') segments.push({ kind: 'compact', start: a.since })
  }
  for (const e of evs(list, 'context.compacted')) segments.push({ kind: 'compact', start: e.ts, end: e.ts })

  return { nodeId: g.id, title: g.title, kind: g.kind, stage: g.stage, parent: g.parent, segments, invocations: invocations.length ? invocations : undefined }
}

/** 上下文曲线：每轮输入 token 按会话增长近似，压缩点回落；运行中的节点逼近窗口 85%，演示琥珀区。 */
function contextOf(run: MockRun, lane: Lane, now: number): RunTimeline['context'][number] | undefined {
  const inv = lane.invocations
  if (!inv?.length) return undefined
  const g = run.graph.nodes.find((n) => n.id === lane.nodeId)!
  const harness = inv[inv.length - 1]!.harness
  const window = lane.nodeId === NO_WINDOW || lane.nodeId.endsWith(`/${NO_WINDOW}`) ? undefined : WINDOW[harness]
  const compactions = evs(run.events.filter((e) => e.nodeId === lane.nodeId), 'context.compacted').map((e) => ({ at: e.ts, before: e.data.beforeTokens, after: e.data.afterTokens }))
  const peakRatio = g.status === 'running' ? 0.86 : 0.22 + (hash(lane.nodeId) % 40) / 100
  const cap = window ?? 160_000
  const points: Array<{ at: string; tokens: number }> = []
  for (const v of inv) {
    const start = Date.parse(v.start)
    const end = v.end ? Date.parse(v.end) : now
    const n = Math.max(4, Math.min(16, Math.round((end - start) / 45_000)))
    let base = 9_000 + (hash(v.id) % 6) * 1000
    for (let i = 0; i <= n; i++) {
      const at = start + ((end - start) * i) / n
      const c = compactions.find((x) => Math.abs(Date.parse(x.at) - at) < (end - start) / n / 2)
      if (c) {
        points.push({ at: iso(at), tokens: c.before })
        base = c.after
        points.push({ at: iso(at + 1), tokens: c.after })
        continue
      }
      const f = Math.pow(i / n, 0.85)
      points.push({ at: iso(at), tokens: Math.round(base + (cap * peakRatio - base) * f) })
    }
  }
  return { nodeId: lane.nodeId, window, points, compactions }
}

export function mockTimeline(run: MockRun, now = Date.now()): RunTimeline {
  const lanes = run.graph.nodes.map((g) => laneOf(run, g, now))
  return {
    start: run.state.startedAt,
    end: run.state.endedAt,
    lanes,
    context: lanes.map((l) => contextOf(run, l, now)).filter((c): c is RunTimeline['context'][number] => Boolean(c)),
  }
}

// ---------------------------------------------------------------- 改动卡与回退

type FileChange = NodeChanges['files'][number]

/** 写代码节点的仓库改动（演示用的固定补丁）。 */
const REPO_PATCHES: Array<[RegExp, Array<{ path: string; status: FileChange['status']; patch: string }>]> = [
  [
    /fix-code$/,
    [
      { path: 'src/export/csv.ts', status: 'modified', patch: '@@ -38,7 +38,9 @@ export function writeRow(row: OrderRow, out: Writable) {\n   const cells = [\n     row.orderNo,\n-    String(row.amount),\n+    // 金额统一两位小数（AC-2）；不用 toFixed 以免浮点误差\n+    formatAmount(row.amount),\n     row.currency,\n     row.createdAt.toISOString(),\n   ]\n@@ -61,3 +63,4 @@ export function header(): string[] {\n   return HEADER\n }\n+export { formatAmount } from \'../orders/format\'' },
      { path: 'src/export/stream.ts', status: 'modified', patch: '@@ -14,8 +14,15 @@ export async function exportOrders(filter: OrderFilter, res: Response) {\n-  const rows = await repo.search(filter)\n-  res.write(toCsv(rows))\n+  const CHUNK = 5000\n+  let offset = 0\n+  for (;;) {\n+    const rows = await repo.search(filter, { offset, limit: CHUNK })\n+    if (rows.length === 0) break\n+    res.write(toCsv(rows, { header: offset === 0 }))\n+    offset += rows.length\n+    progress.report(offset)\n+  }\n   res.end()\n }' },
      { path: 'src/export/stream.test.ts', status: 'added', patch: '@@ -0,0 +1,12 @@\n+import { describe, expect, it } from \'vitest\'\n+import { exportOrders } from \'./stream\'\n+\n+describe(\'exportOrders\', () => {\n+  it(\'超过 1 万行时分片写出\', async () => {\n+    const out = await collect(exportOrders(filterOf(12_000)))\n+    expect(out.chunks).toBe(3)\n+  })\n+  it(\'金额保留两位小数\', async () => {\n+    expect(await firstRow(exportOrders(filterOf(1)))).toContain(\'12.50\')\n+  })\n+})' },
    ],
  ],
  [
    /fix-script$/,
    [{ path: 'e2e/export.spec.ts', status: 'modified', patch: '@@ -22,6 +22,6 @@ test(\'导出进度提示\', async ({ page }) => {\n   await page.getByTestId(\'order-export-btn\').click()\n-  await page.waitForTimeout(500)\n-  await expect(page.getByText(\'导出中\')).toBeVisible()\n+  // 等进度条真正出现，而不是固定 500ms\n+  await expect(page.getByRole(\'progressbar\')).toBeVisible({ timeout: 10_000 })\n }' }],
  ],
  [
    /\/code$/,
    [
      { path: 'src/export/<key>.ts', status: 'added', patch: '@@ -0,0 +1,9 @@\n+import type { OrderFilter } from \'../orders/types\'\n+\n+/** <key>：见 design/design.md 的分片方案。 */\n+export async function run(filter: OrderFilter) {\n+  const task = await tasks.create({ kind: \'export\', filter })\n+  queue.push(task.id)\n+  return { taskId: task.id }\n+}\n+' },
      { path: 'src/routes/orders.ts', status: 'modified', patch: '@@ -40,4 +40,6 @@ router.get(\'/orders/search\', search)\n router.get(\'/orders/:id\', detail)\n+// 导出：只有 export 权限可见（AC-5）\n+router.post(\'/orders/export\', requirePermission(\'order:export\'), exportOrders)\n export default router' },
    ],
  ],
  [/^automate$/, [{ path: 'e2e/export.spec.ts', status: 'added', patch: '@@ -0,0 +1,4 @@\n+import { test, expect } from \'@playwright/test\'\n+\n+test(\'导出当前筛选结果\', async ({ page }) => {\n+})' }]],
]

/** 演示"没有回退点"：M5 之前运行的节点没有记录。 */
const NO_REWIND_POINT = new Set(['automate'])

function patchStat(patch: string): { add: number; del: number } {
  const lines = patch.split('\n')
  return { add: lines.filter((l) => l.startsWith('+')).length, del: lines.filter((l) => l.startsWith('-')).length }
}

function toPatch(before: string, after: string): string {
  const lines = lineDiff(before, after)
  const a = before ? before.split('\n').length : 0
  const b = after.split('\n').length
  return [`@@ -${a ? 1 : 0},${a} +1,${b} @@`, ...lines.map((l) => `${l.t}${l.text}`)].join('\n')
}

export interface MockChanges {
  changes(run: MockRun, nodeId: string): NodeChanges
  diff(run: MockRun, nodeId: string, path?: string): string
  preview(run: MockRun, nodeId: string): RewindPreview
  /** 返回 'conflict' 表示 token 不符。 */
  rewind(run: MockRun, nodeId: string, token: string, reason: string): RewindPreview | 'conflict' | string
}

export function createMockChanges(db: MockDb, onRewound: (run: MockRun, nodeId: string, preview: RewindPreview, reason: string) => void): MockChanges {
  /** 已回退过的节点：改动卡清空。 */
  const rewound = new Set<string>()
  /** 每个节点第一次执行回退时返回一次 409（演示"状态变了，已重新预览"）。 */
  const conflicted = new Set<string>()

  function repoFiles(nodeId: string): Array<FileChange & { patch: string }> {
    const key = nodeId.split('/')[1] ?? ''
    const hit = REPO_PATCHES.find(([re]) => re.test(nodeId))
    return (hit?.[1] ?? []).map((f) => ({ path: f.path.replace('<key>', key), scope: 'repo', repo: 'app', status: f.status, patch: f.patch.replaceAll('<key>', key), ...patchStat(f.patch) }))
  }

  function workspaceFiles(run: MockRun, nodeId: string): Array<FileChange & { patch: string }> {
    const reqId = run.state.requirementId
    const outputs = run.state.nodes[nodeId]?.outputs ?? []
    return outputs.flatMap((r) => {
      const to = r.version ?? 1
      const from = to > 1 ? to - 1 : undefined
      const after = db.contents.get(`${reqId}:${r.path}@${to}`)?.content
      if (after === undefined) return []
      const before = from ? (db.contents.get(`${reqId}:${r.path}@${from}`)?.content ?? '') : ''
      const patch = toPatch(before, after)
      return [{ path: r.path, scope: 'workspace' as const, status: from ? ('modified' as const) : ('added' as const), from, to, patch, ...patchStat(patch) }]
    })
  }

  function all(run: MockRun, nodeId: string) {
    if (rewound.has(`${run.state.runId}:${nodeId}`)) return []
    return [...repoFiles(nodeId), ...workspaceFiles(run, nodeId)]
  }

  function downstream(run: MockRun, nodeId: string): string[] {
    const seen = new Set<string>()
    const queue = [nodeId]
    while (queue.length) {
      const cur = queue.shift()!
      if (seen.has(cur)) continue
      seen.add(cur)
      for (const e of run.graph.edges) if (e.from === cur && e.kind !== 'route') queue.push(e.to)
      for (const n of run.graph.nodes) if (n.parent === cur) queue.push(n.id)
    }
    return [...seen]
  }

  function blockedOf(run: MockRun, nodeId: string): string | undefined {
    const g = run.graph.nodes.find((n) => n.id === nodeId)
    if (!g) return '节点不存在'
    if (g.status === 'running') return '节点正在运行，结束后才能回退'
    if (g.status === 'pending' || g.status === 'ready' || g.status === 'skipped') return '节点还没有执行，没有可退回的改动'
    if (NO_REWIND_POINT.has(nodeId)) return '这个节点执行时还没有记录回退点（M5 之前的运行），只能手动恢复'
    const busy = downstream(run, nodeId).filter((id) => id !== nodeId).map((id) => run.graph.nodes.find((n) => n.id === id)).find((n) => n?.status === 'running')
    if (busy) return `下游节点「${busy.title}」正在运行，等它结束或先取消运行`
    return undefined
  }

  function token(run: MockRun, nodeId: string): string {
    const versions = (db.artifacts.get(run.state.requirementId) ?? []).map((a) => `${a.path}@${a.versions.length}`).join(',')
    return sha(`${run.state.runId}:${nodeId}:${run.state.nodes[nodeId]?.status}:${versions}:${rewound.has(`${run.state.runId}:${nodeId}`)}`)
  }

  const strip = (f: FileChange & { patch?: string }): FileChange => {
    const { patch: _patch, ...rest } = f
    return rest
  }

  return {
    changes(run, nodeId) {
      const files = all(run, nodeId)
      const st = run.state.nodes[nodeId]
      const blocked = blockedOf(run, nodeId)
      const point = st?.startedAt && !NO_REWIND_POINT.has(nodeId)
        ? {
            repos: files.some((f) => f.scope === 'repo') ? [{ repo: 'app', path: `.takt/worktrees/${run.state.runId}/${nodeId.replaceAll('/', '__')}`, head: sha(`${nodeId}:head`).slice(0, 7) }] : undefined,
            artifacts: files.filter((f) => f.scope === 'workspace' && f.from).map((f) => ({ workspace: run.state.requirementId, path: f.path, version: f.from })),
            at: st.startedAt,
          }
        : undefined
      return {
        files: files.map(strip),
        add: files.reduce((s, f) => s + f.add, 0),
        del: files.reduce((s, f) => s + f.del, 0),
        rewindPoint: point,
        rewindBlocked: files.length || blocked ? blocked : '这个节点没有改动文件',
      }
    },
    diff(run, nodeId, path) {
      return all(run, nodeId)
        .filter((f) => !path || f.path === path)
        .map((f) => `--- a/${f.path}\n+++ b/${f.path}\n${f.patch}`)
        .join('\n')
    },
    preview(run, nodeId) {
      const files = all(run, nodeId).map(strip)
      const stale = downstream(run, nodeId)
        .map((id) => run.graph.nodes.find((n) => n.id === id))
        .filter((n): n is GraphNode => Boolean(n) && (n!.id === nodeId || n!.status === 'succeeded' || n!.status === 'failed'))
        .map((n) => ({ runId: run.state.runId, nodeId: n.id, title: n.title }))
      return { nodeId, files, stale, blocked: blockedOf(run, nodeId) ?? (files.length ? undefined : '这个节点没有改动文件'), token: token(run, nodeId) }
    },
    rewind(run, nodeId, t, reason) {
      if (!reason.trim()) return '回退需要写原因'
      const key = `${run.state.runId}:${nodeId}`
      if (t !== token(run, nodeId)) return 'conflict'
      if (!conflicted.has(key)) {
        conflicted.add(key)
        return 'conflict'
      }
      const p = this.preview(run, nodeId)
      if (p.blocked) return p.blocked
      rewound.add(key)
      onRewound(run, nodeId, p, reason)
      return p
    },
  }
}
