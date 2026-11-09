import type { NodeActivity } from '../api.js'
import type { EventEnvelope, EventPayloads } from '../types.js'

export function nodeActivity(events: EventEnvelope[], now = Date.now()): NodeActivity | undefined {
  const ordered = [...events].sort((a, b) => a.seq - b.seq)
  const start = ordered.map(event => event.type).lastIndexOf('node.started')
  if (start < 0) return undefined
  const tools = new Map<string, NodeActivity>()
  let activity: NodeActivity = { state: 'thinking', since: ordered[start]!.ts }
  for (const event of ordered.slice(start + 1)) {
    if (['node.finished', 'node.failed', 'node.stale', 'node.rewound', 'human.requested'].includes(event.type)) return undefined
    if (event.type === 'harness.tool_call') {
      const data = event.data as EventPayloads['harness.tool_call']
      if (data.phase === 'start' && data.callId) tools.set(data.callId, { state: 'tool', tool: data.tool, input: data.input, since: event.ts })
      else {
        if (data.callId) tools.delete(data.callId)
        activity = { state: 'thinking', ...(data.phase === undefined ? { tool: data.tool, input: data.input } : {}), since: event.ts }
      }
    } else if (event.type === 'harness.started') activity = { state: 'thinking', since: event.ts }
    // 连续的思考片段是同一段思考：不重置开始时间，否则节点一直显示"思考中 0s"、长步骤也永远判不出来
    else if (event.type === 'harness.message') { if (activity.state !== 'thinking' || activity.tool) activity = { state: 'thinking', since: event.ts } }
    else if (event.type === 'context.compacted') activity = { state: 'compacting', since: event.ts }
    else if (event.type === 'invocation.finished') { tools.clear(); activity = { state: 'thinking', since: event.ts } }
  }
  if (tools.size) return [...tools.values()].at(-1)
  if (activity.tool && now - Date.parse(activity.since) >= 15_000) return { ...activity, state: 'waiting_tool' }
  return activity.tool ? { state: 'thinking', since: activity.since } : activity
}
