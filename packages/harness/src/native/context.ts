import { estimateTokens, type ChatMessage, type HarnessEvent, type ModelConfig, type Usage } from '@taktflow/core'

export function contextTokens(messages: ChatMessage[]): number { return estimateTokens(JSON.stringify(messages)) }

export function compact(messages: ChatMessage[], window: number, emit: (event: HarnessEvent) => void): boolean {
  const beforeTokens = contextTokens(messages)
  if (beforeTokens <= window * 0.8) return false
  const dropped: string[] = []
  for (const [index, message] of messages.entries()) {
    if (index >= messages.length - 6 || message.role !== 'tool' || message.content.length < 256) continue
    const length = message.content.length
    message.content = `[Earlier tool result compacted: ${length} characters; re-read the source if needed]\n${message.content.slice(0, 120)}`
    dropped.push(message.toolCallId ?? String(index))
  }
  if (!dropped.length) return false
  emit({ type: 'compacted', record: {
    at: new Date().toISOString(), trigger: 'auto', beforeTokens, afterTokens: contextTokens(messages),
    summary: 'Replaced early tool results with short excerpts; preserved tool-call pairs, prompts and recent messages.', dropped,
  } })
  return true
}

export function pricedUsage(usage: Usage, price?: ModelConfig['price']): Usage {
  for (const value of [usage.inputTokens, usage.outputTokens, usage.cachedTokens ?? 0, usage.costUsd ?? 0]) {
    if (!Number.isFinite(value) || value < 0) throw new Error('Provider returned invalid usage')
  }
  if (!price) return usage
  for (const value of [price.input, price.output, price.cachedInput ?? price.input]) {
    if (!Number.isFinite(value) || value < 0) throw new Error('Invalid model price')
  }
  const cached = Math.min(usage.cachedTokens ?? 0, usage.inputTokens)
  return { ...usage, costUsd: ((usage.inputTokens - cached) * price.input + cached * (price.cachedInput ?? price.input) + usage.outputTokens * price.output) / 1_000_000 }
}
