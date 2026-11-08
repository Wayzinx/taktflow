import type { RunTimeline } from '../api.js'
import type { EventEnvelope, EventPayloads, RunState, WorkflowSnapshot } from '../types.js'
import { buildRunGraph } from './graph.js'

type Segment = RunTimeline['lanes'][number]['segments'][number]
export function runTimeline(state: RunState, events: EventEnvelope[], snapshot: WorkflowSnapshot, now = Date.now()): RunTimeline {
  const timeline: RunTimeline = { start: state.startedAt, end: state.endedAt, lanes: [], context: [] }
  for (const node of buildRunGraph(snapshot, state).nodes) {
    const lane: RunTimeline['lanes'][number] = { nodeId: node.id, title: node.title, kind: node.kind, stage: node.stage, parent: node.parent, segments: [], invocations: [] }
    const context: RunTimeline['context'][number] = { nodeId: node.id, points: [], compactions: [] }
    const tools = new Map<string, Segment>()
    let active: Segment | undefined
    let compact: Segment | undefined
    let invocationId: string | undefined
    const close = (at: string) => { if (active) active.end = at; active = undefined }
    const open = (kind: Segment['kind'], event: EventEnvelope, extra: Partial<Segment> = {}) => {
      close(event.ts); active = { kind, start: event.ts, invocationId, ...extra }; lane.segments.push(active)
    }
    for (const event of events.filter(event => event.nodeId === node.id).sort((a, b) => a.seq - b.seq)) {
      if (compact && ['harness.message', 'harness.tool_call', 'harness.started', 'node.finished', 'node.failed'].includes(event.type)) { compact.end = event.ts; compact = undefined }
      switch (event.type) {
        case 'node.ready': open('queue', event); break
        case 'node.started': open('run', event); break
        case 'human.requested': open('wait', event, { requestId: (event.data as EventPayloads['human.requested']).requestId }); break
        case 'human.answered': case 'human.handed_back': close(event.ts); break
        case 'node.finished': case 'node.failed': case 'node.stale':
          close(event.ts)
          for (const tool of tools.values()) tool.end = event.ts
          tools.clear()
          break
        case 'invocation.started': {
          const data = event.data as EventPayloads['invocation.started']
          invocationId = data.id
          if (active?.kind === 'run') open('run', event)
          lane.invocations!.push({ id: data.id, harness: data.harness, model: data.model.reported, start: event.ts })
          break
        }
        case 'invocation.finished': {
          const data = event.data as EventPayloads['invocation.finished']
          const invocation = lane.invocations!.find(item => item.id === data.id)
          if (invocation) { invocation.end = event.ts; invocation.outcome = data.outcome; invocation.model = data.reported?.model ?? invocation.model }
          for (const [id, tool] of tools) if (tool.invocationId === data.id) { tool.end = event.ts; tools.delete(id) }
          invocationId = undefined
          break
        }
        case 'harness.started': {
          const data = event.data as EventPayloads['harness.started']
          context.window = data.contextWindow
          const current = lane.invocations!.find(item => item.id === invocationId)
          if (current && data.model) current.model = data.model
          break
        }
        case 'harness.usage': context.points.push({ at: event.ts, tokens: (event.data as EventPayloads['harness.usage']).inputTokens }); break
        case 'context.compacted': {
          const data = event.data as EventPayloads['context.compacted']
          context.compactions.push({ at: event.ts, before: data.beforeTokens, after: data.afterTokens })
          compact = { kind: 'compact', start: event.ts, invocationId }; lane.segments.push(compact)
          break
        }
        case 'harness.tool_call': {
          const data = event.data as EventPayloads['harness.tool_call']
          const id = `${invocationId ?? ''}:${data.callId ?? ''}`
          if (data.phase === 'start') {
            const segment: Segment = { kind: 'tool', start: event.ts, tool: data.tool, input: data.input, invocationId }
            tools.set(id, segment); lane.segments.push(segment)
          } else {
            const segment = data.callId ? tools.get(id) : undefined
            if (segment) { segment.end = event.ts; segment.ok = data.ok; tools.delete(id) }
            else lane.segments.push({ kind: 'tool', start: new Date(Date.parse(event.ts) - (data.durationMs ?? 0)).toISOString(), end: event.ts, tool: data.tool, input: data.input, ok: data.ok, invocationId })
          }
          break
        }
      }
    }
    for (const segment of lane.segments) if (segment.kind === 'tool') segment.long = (segment.end ? Date.parse(segment.end) : now) - Date.parse(segment.start) >= 15_000
    if (!lane.invocations!.length) delete lane.invocations
    timeline.lanes.push(lane)
    if (context.points.length || context.compactions.length) timeline.context.push(context)
  }
  return timeline
}
