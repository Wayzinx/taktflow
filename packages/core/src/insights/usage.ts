import type { EventEnvelope, EventPayloads, Usage } from '../types.js'

export function addUsage(a: Usage, b: Usage): Usage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    ...(a.cachedTokens !== undefined || b.cachedTokens !== undefined ? { cachedTokens: (a.cachedTokens ?? 0) + (b.cachedTokens ?? 0) } : {}),
    ...(a.costUsd !== undefined || b.costUsd !== undefined ? { costUsd: (a.costUsd ?? 0) + (b.costUsd ?? 0) } : {}),
  }
}

export function orderedEvents(events: EventEnvelope[]): EventEnvelope[] {
  return [...events].sort((a, b) => a.runId.localeCompare(b.runId) || a.seq - b.seq)
}

export function summarizeUsage(events: EventEnvelope[]): Usage {
  let total: Usage = { inputTokens: 0, outputTokens: 0 }
  const streamed = new Map<string, Usage>()
  const flush = (key: string, fallback?: Usage) => {
    const usage = streamed.get(key)
    if (usage) {
      // 流式用量和 node.finished 是同一次执行的两种记录，只补齐流中没有的可选字段。
      total = addUsage(total, { ...usage, cachedTokens: usage.cachedTokens ?? fallback?.cachedTokens, costUsd: usage.costUsd ?? fallback?.costUsd })
    } else if (fallback) total = addUsage(total, fallback)
    streamed.delete(key)
  }
  for (const event of orderedEvents(events)) {
    const key = JSON.stringify([event.runId, event.nodeId])
    if (event.type === 'node.started') flush(key)
    if (event.type === 'harness.usage') {
      const usage = streamed.get(key) ?? { inputTokens: 0, outputTokens: 0 }
      streamed.set(key, addUsage(usage, event.data as EventPayloads['harness.usage']))
    }
    if (event.type === 'node.finished') flush(key, (event.data as EventPayloads['node.finished']).usage)
  }
  for (const key of streamed.keys()) flush(key)
  return total
}
