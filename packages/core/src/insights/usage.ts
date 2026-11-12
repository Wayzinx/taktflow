import type { EventEnvelope, EventPayloads, Usage } from '../types.js'

/** 没报成本的 token：有 costUsd 时看 unpricedTokens（省略即 0），没有 costUsd 就是整份都没报。 */
const unpricedOf = (u: Usage) => u.unpricedTokens ?? (u.costUsd === undefined ? u.inputTokens + u.outputTokens : 0)

/**
 * 成本只累加报了的部分，没报的 token 记进 unpricedTokens，界面据此写"≥$x、覆盖 y%"。
 * 有 token 的调用全都没报成本时（只有零用量的调用带了 costUsd: 0）成本是未知，不是 $0：不输出 costUsd。
 */
export function addUsage(a: Usage, b: Usage): Usage {
  const inputTokens = a.inputTokens + b.inputTokens
  const outputTokens = a.outputTokens + b.outputTokens
  const unpricedTokens = unpricedOf(a) + unpricedOf(b)
  const costUsd = (a.costUsd ?? 0) + (b.costUsd ?? 0)
  const priced = (a.costUsd !== undefined || b.costUsd !== undefined) && (costUsd !== 0 || unpricedTokens < inputTokens + outputTokens || unpricedTokens === 0)
  return {
    inputTokens,
    outputTokens,
    ...(a.cachedTokens !== undefined || b.cachedTokens !== undefined ? { cachedTokens: (a.cachedTokens ?? 0) + (b.cachedTokens ?? 0) } : {}),
    ...(priced ? { costUsd } : {}),
    ...(priced && unpricedTokens ? { unpricedTokens } : {}),
  }
}

export function orderedEvents(events: EventEnvelope[]): EventEnvelope[] {
  return [...events].sort((a, b) => a.runId.localeCompare(b.runId) || a.seq - b.seq)
}

/**
 * 一次运行里每次调用 harness 都记一条 harness.usage（增量）：评审的每位评审每一轮、裁决、失败重试都在里面，和预算条同一口径。
 * node.finished.usage 只是节点最后一次调用的量；没有 harness.usage 的旧运行才退回用它。
 */
function usageEvents(events: EventEnvelope[]): Array<{ nodeId?: string; usage: Usage }> {
  const metered = new Set(events.filter((event) => event.type === 'harness.usage').map((event) => event.runId))
  return events.flatMap((event) => {
    if (metered.has(event.runId) ? event.type !== 'harness.usage' : event.type !== 'node.finished') return []
    const usage = event.type === 'harness.usage' ? event.data as EventPayloads['harness.usage'] : (event.data as EventPayloads['node.finished']).usage
    return usage ? [{ nodeId: event.nodeId, usage }] : []
  })
}

export function summarizeUsage(events: EventEnvelope[]): Usage {
  return usageEvents(events).reduce((total, { usage }) => addUsage(total, usage), { inputTokens: 0, outputTokens: 0 })
}

export function nodeUsage(events: EventEnvelope[], runId: string): Map<string, Usage> {
  const result = new Map<string, Usage>()
  for (const { nodeId, usage } of usageEvents(events.filter((event) => event.runId === runId))) {
    if (nodeId !== undefined) result.set(nodeId, addUsage(result.get(nodeId) ?? { inputTokens: 0, outputTokens: 0 }, usage))
  }
  return result
}
