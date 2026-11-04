import type { GraphEdge, GraphNode, RunDetail, StageProgress } from '../api.js'
import type { EventEnvelope, RunState, SnapshotNode, WorkflowSnapshot } from '../types.js'
import { nodeUsage } from './usage.js'
import type { RunGraphNode } from '../store/run-graph.js'

export function buildRunGraph(snapshot: WorkflowSnapshot, state: RunState, records: RunGraphNode[] = [], events?: EventEnvelope[]): RunDetail['graph'] {
  const usage = events === undefined ? undefined : nodeUsage(events, state.runId)
  const authoritative = new Set<string>()
  const nodes = new Map<string, GraphNode>()
  const definitions = new Map<string, SnapshotNode>()
  const edges = new Map<string, GraphEdge>()
  const addEdge = (edge: GraphEdge) => {
    if (nodes.has(edge.from) && nodes.has(edge.to)) edges.set(JSON.stringify(edge), edge)
  }
  const visit = (definitionsInScope: SnapshotNode[], parent?: string, stage?: string, prefix = parent, expanded = false) => {
    for (const definition of definitionsInScope) {
      const id = prefix ? `${prefix}/${definition.id}` : definition.id
      const runtime = state.nodes[id]
      const node: GraphNode = {
        id, kind: definition.kind, title: definition.title,
        stage: definition.stage ?? stage, parent, role: definition.role,
        harness: runtime?.sessionRef?.harness ?? definition.harness,
        status: runtime?.status ?? 'pending', attempts: runtime?.attempts ?? 0,
        iteration: runtime?.iteration, usage: usage === undefined ? runtime?.usage : usage.get(id) ?? { inputTokens: 0, outputTokens: 0 },
      }
      nodes.set(id, node)
      definitions.set(id, definition)
      if (expanded) authoritative.add(id)
      if (definition.body) visit(definition.body, id, node.stage, id, expanded)
    }
  }
  visit(snapshot.nodes)

  // 新记录保留完整定义；旧记录只有 ID 时仍使用占位节点。
  const pending = [...state.expansions]
  while (pending.length) {
    const index = pending.findIndex((expansion) => nodes.has(expansion.plannerId))
    if (index < 0) break
    const expansion = pending.splice(index, 1)[0]!
    const planner = nodes.get(expansion.plannerId)!
    visit(expansion.nodes ?? [], planner.id, planner.stage, '', true)
    for (const id of new Set([...expansion.nodeIds, ...(expansion.nodes ?? []).map((node) => node.id)])) {
      if (id === planner.id) continue
      if (!nodes.has(id)) {
        const runtime = state.nodes[id]
        nodes.set(id, {
          id, kind: 'subflow', title: `${id}（展开节点，定义未持久化）`,
          parent: planner.id, stage: planner.stage,
          status: runtime?.status ?? 'pending', attempts: runtime?.attempts ?? 0,
          iteration: runtime?.iteration, usage: usage === undefined ? runtime?.usage : usage.get(id) ?? { inputTokens: 0, outputTokens: 0 },
          harness: runtime?.sessionRef?.harness,
        })
      }
      addEdge({ from: planner.id, to: id, kind: 'expand' })
    }
  }

  for (const record of records) {
    if (authoritative.has(record.id)) continue
    const existing = nodes.get(record.id)
    const runtime = state.nodes[record.id]
    nodes.set(record.id, {
      id: record.id, kind: record.kind ?? existing?.kind ?? 'subflow',
      title: record.title ?? existing?.title ?? `${record.id}（展开节点，定义未持久化）`,
      parent: record.parent ?? existing?.parent, stage: record.stage ?? existing?.stage,
      role: record.role ?? existing?.role,
      harness: runtime?.sessionRef?.harness ?? record.harness ?? existing?.harness,
      status: runtime?.status ?? 'pending', attempts: runtime?.attempts ?? 0,
      iteration: runtime?.iteration, usage: usage === undefined ? runtime?.usage : usage.get(record.id) ?? { inputTokens: 0, outputTokens: 0 },
    })
  }
  // 记录可能乱序，等所有父节点存在后继承阶段。
  for (let pass = 0; pass < nodes.size; pass++) {
    let changed = false
    for (const node of nodes.values()) {
      const stage = node.parent ? nodes.get(node.parent)?.stage : undefined
      if (!node.stage && stage) { node.stage = stage; changed = true }
    }
    if (!changed) break
  }
  const recorded = new Map(records.map((record) => [record.id, record]))
  for (const record of records) {
    if (authoritative.has(record.id)) continue
    for (const from of record.needs) addEdge({ from, to: record.id, kind: 'dep' })
    if (record.parent && nodes.get(record.parent)?.kind === 'planner') addEdge({ from: record.parent, to: record.id, kind: 'expand' })
  }

  const resolve = (reference: string, parent?: string): string | undefined => {
    let scope = parent
    while (scope) {
      const candidate = `${scope}/${reference}`
      if (nodes.has(candidate)) return candidate
      scope = nodes.get(scope)?.parent
    }
    return nodes.has(reference) ? reference : undefined
  }
  for (const [id, definition] of definitions) {
    const parent = nodes.get(id)?.parent
    for (const dependency of recorded.has(id) && !authoritative.has(id) ? [] : definition.needs) {
      const from = resolve(dependency, parent)
      if (from) addEdge({ from, to: id, kind: 'dep' })
    }
    for (const [label, target] of Object.entries(definition.routes ?? {})) {
      if (target === 'human' || target === 'ignore') continue
      const to = resolve(target, parent)
      if (to) addEdge({ from: id, to, kind: 'route', label })
    }
  }
  return { nodes: [...nodes.values()], edges: [...edges.values()] }
}

export function stageProgress(snapshot: WorkflowSnapshot, state: RunState, records?: RunGraphNode[]): StageProgress[] {
  const graph = buildRunGraph(snapshot, state, records)
  return snapshot.stages.map((stage) => {
    const nodes = graph.nodes.filter((node) => node.stage === stage.id)
    const done = nodes.filter((node) => node.status === 'succeeded' || node.status === 'skipped').length
    const statuses = new Set(nodes.map((node) => node.status))
    const status = statuses.has('failed') || statuses.has('blocked') || statuses.has('cancelled') ? 'failed'
      : statuses.has('waiting_human') ? 'waiting_human'
        : nodes.length > 0 && done === nodes.length ? 'done'
          : done > 0 || ['running', 'ready', 'stale'].some((value) => statuses.has(value as GraphNode['status'])) ? 'running'
            : 'todo'
    return { ...stage, status, done, total: nodes.length }
  })
}
