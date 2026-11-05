import { reviewDetail, addUsage, deriveRequirementState, loadRunGraph, buildRunGraph, createInsights, stageProgress, summarizeRun, type NodeDetail, type ProjectOverview, type ProjectStores, type Requirement, type RequirementSummary, type RunState, type SnapshotNode, type EventPayloads, type WorkflowSnapshot } from '@taktflow/core'
import { ApiError as HttpError } from './errors.js'
import { relativePath, runId as validRunId, safeId } from './validation.js'

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
  const [runs, attention, metrics] = await Promise.all([
    stores.runs.list({ requirementId: item.id }),
    stores.attention.list({ pending: true, requirementId: item.id }),
    createInsights(stores).metrics(item.id),
  ])
  const latest = runs.filter((run) => (run as RunState & { kind?: string }).kind !== 'task' && run.workflowId !== 'lead' && !run.workflowId.startsWith('task:'))
    .sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt) || a.runId.localeCompare(b.runId)).at(-1)
  const snapshot = latest ? await workflow(stores, latest.runId) : undefined
  const derived = latest && snapshot && item.status !== 'archived' ? deriveRequirementState(snapshot, latest) : {}
  return { ...item, ...derived, stages: latest && snapshot ? stageProgress(snapshot, latest, await loadRunGraph(stores, latest.runId)) : [], latestRunId: latest?.runId, pendingAttention: attention.length, usage: metrics.usage }
}

export async function summaries(stores: ProjectStores): Promise<RequirementSummary[]> {
  return Promise.all((await stores.workspaces.listRequirements()).map((item) => summary(stores, item)))
}

export async function overview(stores: ProjectStores): Promise<ProjectOverview> {
  const [requirements, attention, runs] = await Promise.all([summaries(stores), stores.attention.list({ pending: true }), stores.runs.list()])
  const usage = requirements.reduce((total, item) => addUsage(total, item.usage), { inputTokens: 0, outputTokens: 0 })
  return { ...stores.config.project, requirements, attention, totals: { requirements: requirements.length, active: requirements.filter((r) => r.status === 'active').length, delivered: requirements.filter((r) => r.status === 'delivered').length, blocked: requirements.filter((r) => r.status === 'blocked').length, runs: runs.length, usage } }
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
  const gate = events.filter((event) => event.type === 'gate.result').at(-1)?.data as EventPayloads['gate.result'] | undefined
  const outputs: NodeDetail['outputs'] = []
  for (const ref of node.outputs) {
    const records = ref.workspace === state.requirementId ? artifacts : await stores.workspaces.listArtifacts(ref.workspace)
    const record = records.find((item) => item.path === ref.path)
    const version = ref.version ?? record?.versions.at(-1)?.version
    if (version === undefined) throw new Error(`节点输出缺少版本：${nodeId}/${ref.path}`)
    outputs.push({ path: ref.path, version, kind: record?.kind ?? 'other' })
  }
  return { state: node, kind: graphNode.kind, title: graphNode.title, stage: graphNode.stage, role: graphNode.role, checks: snapshots.get(nodeId)?.checks, prompt, inputs: (node.inputs ?? []).map(({ path, version }) => ({ path, version })), outputs, context, review: await reviewDetail(stores, runId, nodeId), ...(verdicts.length ? { verdicts } : {}), ...(gate ? { gate } : {}), events }
}

export async function runSummaries(stores: ProjectStores, states: RunState[]) {
  return Promise.all(states.map(async (state) => {
    const events = await stores.events.read(state.runId)
    const explicit = state as RunState & Pick<import('@taktflow/core').RunSummary, 'kind' | 'origin'>
    const messages = await stores.chat.list(state.requirementId)
    const taskMessage = messages.find((message) => message.refs?.taskRunId === state.runId && message.replyTo)
    const trigger = messages.find((message) => message.id === taskMessage?.replyTo)
    const dispatch = events.find((event) => event.type === 'task.dispatched' && (event.data as EventPayloads['task.dispatched']).taskRunId === state.runId)?.data as EventPayloads['task.dispatched'] | undefined
    const origin = explicit.origin ?? (trigger ? { kind: 'chat' as const, messageId: trigger.id, by: trigger.author, title: dispatch?.title ?? taskMessage!.text } : undefined)
    return { ...summarizeRun(state, events), kind: explicit.kind ?? (state.workflowId.startsWith('task:') || taskMessage || dispatch ? 'task' as const : 'workflow' as const), ...(origin ? { origin } : {}) }
  }))
}
