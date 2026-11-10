import { runLiveness, nodeQuality, nodeChanges, recipeOf, currentNode, withAttentionStaleness, reviewDetail, addUsage, deriveRequirementState, loadRunGraph, buildRunGraph, createInsights, runDigest, stageProgress, summarizeRun, type NodeDetail, type DailyActivity, type ProjectOverview, type ProjectStores, type Requirement, type RequirementSummary, type RunSpark, type RunState, type SnapshotNode, type Usage, type EventPayloads, type WorkflowSnapshot } from '@taktflow/core'
import { HttpError, relativePath, runId as validRunId, safeId } from './http.js'

export async function requirement(stores: ProjectStores, id: string): Promise<Requirement> {
  const value = await stores.workspaces.getRequirement(safeId(id))
  if (!value) throw new HttpError(404, '需求不存在')
  return value
}

export async function run(stores: ProjectStores, id: string): Promise<RunState> {
  const value = await stores.runs.get(validRunId(id))
  if (!value) throw new HttpError(404, '运行不存在')
  return value
}

export async function workflow(stores: ProjectStores, id: string): Promise<WorkflowSnapshot> {
  const value = await stores.runs.getWorkflow(id)
  if (!value) throw new Error(`运行 ${id} 缺少 workflow 快照`)
  return value
}

export async function summary(stores: ProjectStores, item: Requirement): Promise<RequirementSummary> {
  return (await summaryWithRuns(stores, item)).summary
}

/** 需求摘要，外加它全部运行与每次运行的用量（总览算每日活动用，避免再读一遍事件）。 */
async function summaryWithRuns(stores: ProjectStores, item: Requirement) {
  const [runs, attention, metrics] = await Promise.all([
    stores.runs.list({ requirementId: item.id }),
    stores.attention.list({ pending: true, requirementId: item.id }),
    createInsights(stores).metrics(item.id),
  ])
  const latest = runs.filter((run) => !isTaskRun(run)).sort(byStart).at(-1)
  const snapshot = latest ? await workflow(stores, latest.runId) : undefined
  const records = latest ? await loadRunGraph(stores, latest.runId) : []
  const graph = latest && snapshot ? buildRunGraph(snapshot, latest, records) : undefined
  const derived = latest && snapshot && item.status !== 'archived' ? deriveRequirementState(snapshot, latest) : {}
  const value: RequirementSummary = { ...item, ...derived, stages: latest && snapshot ? stageProgress(snapshot, latest, records) : [], latestRunId: latest?.runId, pendingAttention: attention.length, usage: metrics.usage, quality: metrics.quality, tier: latest?.route?.tier, current: latest && graph ? currentNode(latest, graph) : undefined, recentRuns: recentRuns(runs, metrics.runUsage ?? {}) }
  return { summary: value, runs, runUsage: metrics.runUsage ?? {} }
}

/** Lead 自己的运行与它派发的任务不算流水线运行。 */
const isTaskRun = (run: RunState) => run.kind === 'task' || run.workflowId === 'lead' || run.workflowId.startsWith('task:')
const tokensOf = (usage?: Usage) => (usage ? usage.inputTokens + usage.outputTokens : 0)
const byStart = (a: RunState, b: RunState) => Date.parse(a.startedAt) - Date.parse(b.startedAt) || a.runId.localeCompare(b.runId)

/** 最近 12 次运行（含任务运行），需求行的迷你柱用。 */
function recentRuns(runs: RunState[], usage: Record<string, Usage>): RunSpark[] {
  return [...runs].sort(byStart).slice(-12).map((run) => ({ runId: run.runId, status: run.status, startedAt: run.startedAt, tokens: tokensOf(usage[run.runId]), kind: isTaskRun(run) ? 'task' : 'workflow' }))
}

const localDay = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`

/** 最近 14 天每天开始的运行数与其 Token（无活动的天补 0），读数格迷你折线用。 */
export function dailyActivity(runs: RunState[], usage: Record<string, Usage>, now = new Date(), days = 14): DailyActivity[] {
  const series = Array.from({ length: days }, (_, i) => ({ day: localDay(new Date(now.getFullYear(), now.getMonth(), now.getDate() - (days - 1 - i))), runs: 0, tokens: 0 }))
  const index = new Map(series.map((entry) => [entry.day, entry]))
  for (const run of runs) {
    const entry = index.get(localDay(new Date(run.startedAt)))
    if (entry) { entry.runs++; entry.tokens += tokensOf(usage[run.runId]) }
  }
  return series
}

export async function summaries(stores: ProjectStores, archived = false): Promise<RequirementSummary[]> {
  return (await withRuns(stores, archived)).map((item) => item.summary)
}

async function withRuns(stores: ProjectStores, archived = false) {
  return Promise.all((await stores.workspaces.listRequirements()).filter((item) => archived || item.status !== 'archived').map((item) => summaryWithRuns(stores, item)))
}

export async function overview(stores: ProjectStores): Promise<ProjectOverview> {
  const [visible, attention, runs] = await Promise.all([withRuns(stores), stores.attention.list({ pending: true }), stores.runs.list()])
  const requirements = visible.map((item) => item.summary)
  // 每日活动只算看得见的需求（与 totals.usage 同口径）
  const daily = dailyActivity(visible.flatMap((item) => item.runs), Object.assign({}, ...visible.map((item) => item.runUsage)))
  const usage = requirements.reduce((total, item) => addUsage(total, item.usage), { inputTokens: 0, outputTokens: 0 })
  const quality = requirements.reduce((sum, item) => {
    sum.verified += item.quality?.verified ?? 0; sum.intercepted += item.quality?.intercepted ?? 0
    for (const key of Object.keys(sum.interceptedBy) as Array<keyof typeof sum.interceptedBy>) sum.interceptedBy[key] += item.quality?.interceptedBy[key] ?? 0
    return sum
  }, { verified: 0, intercepted: 0, interceptedBy: { gate: 0, review: 0, judge: 0, completion: 0, fingerprint: 0 } })
  return { ...stores.config.project, requirements, attention: await withAttentionStaleness(stores, attention.filter((item) => requirements.some((req) => req.id === item.requirementId))), totals: { requirements: requirements.length, active: requirements.filter((r) => r.status === 'active').length, delivered: requirements.filter((r) => r.status === 'delivered').length, blocked: requirements.filter((r) => r.status === 'blocked').length, runs: runs.length, usage, ...quality, daily } }
}

function definitions(nodes: SnapshotNode[], prefix = ''): Map<string, SnapshotNode> {
  const result = new Map<string, SnapshotNode>()
  for (const node of nodes) {
    const id = prefix + node.id
    result.set(id, node)
    if (node.body) for (const [key, value] of definitions(node.body, `${id}/`)) result.set(key, value)
  }
  return result
}

export async function nodeDetail(stores: ProjectStores, runId: string, nodeId: string): Promise<NodeDetail> {
  relativePath(nodeId)
  const state = await run(stores, runId)
  const snapshot = await workflow(stores, runId)
  const node = Object.hasOwn(state.nodes, nodeId) ? state.nodes[nodeId] : undefined
  const [events, context, artifacts] = await Promise.all([
    stores.events.read(runId, { nodeId }), stores.runs.getContext(runId, nodeId), stores.workspaces.listArtifacts(state.requirementId),
  ])
  const graphNode = buildRunGraph(snapshot, state, await loadRunGraph(stores, runId), events).nodes.find((item) => item.id === nodeId)
  if (!node || !graphNode) throw new HttpError(404, '节点不存在')
  const snapshots = definitions(snapshot.nodes)
  for (const expansion of state.expansions) {
    for (const [id, definition] of definitions(expansion.nodes ?? [])) snapshots.set(id, definition)
  }
  let prompt = snapshots.get(nodeId)?.prompt
  for (const event of events) {
    if (event.type === 'context.assembled') {
      const data = event.data as EventPayloads['context.assembled']
      if (!context.snapshots.some((item) => item.nodeId === data.nodeId && item.at === data.at)) context.snapshots.push(data)
    }
    if (event.type === 'context.compacted') {
      const data = event.data as EventPayloads['context.compacted']
      if (!context.compactions.some((item) => item.nodeId === data.nodeId && item.at === data.at)) context.compactions.push(data)
    }
    if (event.type === 'harness.message') {
      const data = event.data as EventPayloads['harness.message']
      if (data.role === 'user') prompt = data.text
    }
  }
  context.snapshots.sort((a, b) => a.at.localeCompare(b.at))
  context.compactions.sort((a, b) => a.at.localeCompare(b.at))
  const verdicts = events.filter((event) => event.type === 'judge.verdict').flatMap((event) => (event.data as EventPayloads['judge.verdict']).verdicts)
  const recordedGate = events.filter((event) => event.type === 'gate.result').at(-1)?.data as EventPayloads['gate.result'] | undefined
  const gate = recordedGate ? { ...recordedGate, checks: recordedGate.checks.map(check => ({ ...check, status: check.status ?? (check.pass ? 'pass' as const : 'fail' as const) })) } : undefined
  const outputs: NodeDetail['outputs'] = []
  for (const ref of node.outputs) {
    const records = ref.workspace === state.requirementId ? artifacts : await stores.workspaces.listArtifacts(ref.workspace)
    const record = records.find((item) => item.path === ref.path)
    const version = ref.version ?? record?.versions.at(-1)?.version
    if (version === undefined) throw new Error(`节点输出缺少版本：${nodeId}/${ref.path}`)
    outputs.push({ path: ref.path, version, kind: record?.kind ?? 'other' })
  }
  const quality = await nodeQuality(stores, runId, nodeId)
  const changes = await nodeChanges(stores, runId, nodeId)
  return { ...quality, changes, state: node, recipe: recipeOf(events, nodeId), goal: snapshots.get(nodeId)?.goal, summary: node.summary, completion: snapshots.get(nodeId)?.completion, completionChecks: node.checks, failures: node.failures, kind: graphNode.kind, title: graphNode.title, stage: graphNode.stage, role: graphNode.role, checks: snapshots.get(nodeId)?.checks, prompt, inputs: (node.inputs ?? []).map(({ path, version }) => ({ path, version })), outputs, context, review: await reviewDetail(stores, runId, nodeId), ...(verdicts.length ? { verdicts } : {}), ...(gate ? { gate } : {}), events }
}

export async function runSummaries(stores: ProjectStores, states: RunState[]) {
  return Promise.all(states.map(async (state) => {
    // 摘要只用到结束事件里的用量和派发事件，按事件文件与运行状态缓存，不必每次轮询都整份解析事件日志
    const { summary, dispatch } = await runDigest(stores, state, 'run-summary', (events) => ({
      summary: summarizeRun(state, events),
      dispatch: events.find((event) => event.type === 'task.dispatched' && (event.data as EventPayloads['task.dispatched']).taskRunId === state.runId)?.data as EventPayloads['task.dispatched'] | undefined,
    }))
    const explicit = state as RunState & Pick<import('@taktflow/core').RunSummary, 'kind' | 'origin'>
    const messages = await stores.chat.list(state.requirementId)
    const taskMessage = messages.find((message) => message.refs?.taskRunId === state.runId && message.replyTo)
    const trigger = messages.find((message) => message.id === taskMessage?.replyTo)
    const origin = explicit.origin ?? (trigger ? { kind: 'chat' as const, messageId: trigger.id, by: trigger.author, title: dispatch?.title ?? taskMessage!.text } : undefined)
    return { ...summary, ...(await runLiveness(stores, state.runId, state) === 'interrupted' ? { interrupted: true as const } : {}), tier: state.route?.tier, kind: explicit.kind ?? (state.workflowId.startsWith('task:') || taskMessage || dispatch ? 'task' as const : 'workflow' as const), ...(origin ? { origin } : {}) }
  }))
}
