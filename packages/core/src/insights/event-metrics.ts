import type { EventEnvelope, EventPayloads, RequirementMetrics, RunState, WorkflowSnapshot } from '../types.js'
import { isObject } from './artifacts.js'
import { buildRunGraph } from './graph.js'
import { orderedEvents } from './usage.js'

export interface EventMetrics {
  firstPassTotal: number
  firstPassPassed: number
  loopIterations: number
  humanInterventions: number
  verdicts: RequirementMetrics['verdicts']
}

export function eventMetrics(events: EventEnvelope[], state: RunState, snapshot?: WorkflowSnapshot): EventMetrics {
  const metrics: EventMetrics = { firstPassTotal: 0, firstPassPassed: 0, loopIterations: 0, humanInterventions: 0, verdicts: {} }
  const graph = snapshot ? buildRunGraph(snapshot, state) : { nodes: [], edges: [] }
  const nodes = new Map(graph.nodes.map((node) => [node.id, node]))
  const starts = new Map<string, EventPayloads['node.started']>()
  const iterations = new Map<string, number>()
  const observed = new Set<string>()
  const measured = new Set<string>()
  const loopsFor = (id: string): string[] => {
    const loops: string[] = []
    let parent = nodes.get(id)?.parent
    while (parent) {
      if (nodes.get(parent)?.kind === 'loop') loops.push(parent)
      parent = nodes.get(parent)?.parent
    }
    return loops
  }
  for (const event of orderedEvents(events)) {
    if (event.type === 'human.answered') metrics.humanInterventions++
    if (event.type === 'judge.verdict') {
      const data = event.data as EventPayloads['judge.verdict']
      for (const verdict of data.verdicts) metrics.verdicts[verdict.category] = (metrics.verdicts[verdict.category] ?? 0) + 1
      metrics.humanInterventions += data.routed.filter((route) => route.to === 'human').length
    }
    if (!event.nodeId) continue
    const id = event.nodeId
    if (event.type === 'node.started') {
      const data = event.data as EventPayloads['node.started']
      starts.set(id, data)
      const loops = loopsFor(id)
      // 缺少快照时 iteration 仍可证明首轮，但不能凭路径猜测 loop 身份或轮次数。
      const loop = loops[0] ?? (nodes.get(id)?.kind === 'loop' ? id : undefined)
      if (loop && data.iteration !== undefined && data.iteration > 0) {
        iterations.set(loop, data.iteration)
        const ancestors = loopsFor(loop).map((ancestor) => [ancestor, iterations.get(ancestor)])
        observed.add(JSON.stringify([loop, ancestors, data.iteration]))
      }
    }
    if (event.type !== 'node.finished') continue
    const started = starts.get(id)
    if (started?.iteration !== 1 || started.attempt !== 1 || measured.has(id)) continue
    const loops = loopsFor(id)
    if (snapshot && (nodes.get(id)?.kind !== 'script' || loops.length === 0)) continue
    if (loops.slice(1).some((loop) => iterations.get(loop) !== 1)) continue
    const data = event.data as EventPayloads['node.finished']
    const result = data.result
    if (!isObject(result) || !Array.isArray(result.failures) || typeof result.total !== 'number'
      || !Number.isInteger(result.total) || result.total <= 0 || result.failures.length > result.total) continue
    measured.add(id)
    metrics.firstPassTotal += result.total
    metrics.firstPassPassed += result.total - result.failures.length
  }
  metrics.loopIterations = observed.size
  return metrics
}
