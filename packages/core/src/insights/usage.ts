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
  // 结束事件是最终用量；流式事件可能是增量或累计值，不能与它混算。
  for (const event of events) {
    if (event.type !== 'node.finished') continue
    const usage = (event.data as EventPayloads['node.finished']).usage
    if (usage) total = addUsage(total, usage)
  }
  return total
}

export function nodeUsage(events: EventEnvelope[], runId: string): Map<string, Usage> {
  const result = new Map<string, Usage>()
  for (const event of events) {
    if (event.runId !== runId || event.nodeId === undefined || event.type !== 'node.finished') continue
    const usage = (event.data as EventPayloads['node.finished']).usage
    if (usage) result.set(event.nodeId, addUsage(result.get(event.nodeId) ?? { inputTokens: 0, outputTokens: 0 }, usage))
  }
  return result
}
