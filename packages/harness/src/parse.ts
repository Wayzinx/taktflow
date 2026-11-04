import type { HarnessEvent, HarnessRequest, HarnessResult, Usage } from '@taktflow/core'

export { addUsage } from '@taktflow/core'

export type JsonObject = Record<string, unknown>
export type EventSink = (event: HarnessEvent) => void
export interface StreamParser {
  onLine(line: string): void
  result(): HarnessResult
}

export function object(value: unknown): JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : {}
}

export function string(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

export function number(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

export function text(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value) ?? ''
}

export function readUsage(value: unknown, camelCase = false): Usage | undefined {
  const data = object(value)
  const inputTokens = number(data[camelCase ? 'inputTokens' : 'input_tokens'])
  const outputTokens = number(data[camelCase ? 'outputTokens' : 'output_tokens'])
  if (inputTokens === undefined || outputTokens === undefined) return undefined
  const cachedTokens = number(camelCase ? data.cacheReadTokens : data.cache_read_input_tokens ?? data.cached_input_tokens)
  return { inputTokens, outputTokens, ...(cachedTokens === undefined ? {} : { cachedTokens }) }
}

export class ParseState {
  value: HarnessResult = { ok: true, finalText: '' }
  private tools = new Map<string, { tool: string; input: string }>()

  constructor(readonly emit: EventSink) {}

  message(value: unknown, role: 'assistant' | 'user' | 'system' = 'system'): void {
    this.emit({ type: 'message', role, text: text(value) })
  }

  fail(value: unknown): void {
    const error = text(value) || 'Unknown CLI error'
    this.value.ok = false
    this.value.error = [this.value.error, error].filter(Boolean).join('\n')
    this.message(error)
  }

  started(sessionId: unknown, model?: unknown): void {
    this.value.sessionId = string(sessionId) ?? this.value.sessionId
    this.emit({ type: 'started', sessionId: this.value.sessionId, model: string(model) })
  }

  tool(id: unknown, tool: string, input: unknown): void {
    const call = { tool, input: text(input) }
    if (typeof id === 'string') this.tools.set(id, call)
    this.emit({ type: 'tool_call', ...call })
  }

  toolResult(id: unknown, output: unknown, ok: boolean, raw: unknown): void {
    const call = typeof id === 'string' ? this.tools.get(id) : undefined
    // 协议没有调用 ID；完成事件必须重复原 tool/input，不能只发一个孤立 output。
    if (call) this.emit({ type: 'tool_call', ...call, output: text(output), ok })
    else this.message(raw)
  }

  parser(handle: (data: JsonObject) => void, result = () => ({ ...this.value })): StreamParser {
    return {
      onLine: line => {
        if (!line.trim()) return
        let value: unknown
        try { value = JSON.parse(line) as unknown } catch {
          if (/^\s*\{/.test(line) && /"type"\s*:/.test(line)) this.fail(`Malformed protocol JSON: ${line}`)
          else this.message(line)
          return
        }
        if (value === null || typeof value !== 'object' || Array.isArray(value)) this.message(value)
        else handle(value as JsonObject)
      },
      result,
    }
  }
}

export function promptWithInstructions(req: HarnessRequest): string {
  // Codex/DSH 的 stdin 只有用户消息；这里的前缀不是原生 system role。
  return req.systemAppend ? `${req.systemAppend}\n\n${req.prompt}` : req.prompt
}
