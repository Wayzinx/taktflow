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
  private tools = new Map<string, { tool: string; input: string; started: number }>()

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

  started(sessionId: unknown, model?: unknown, effort?: unknown, skills?: unknown): void {
    this.value.sessionId = string(sessionId) ?? this.value.sessionId
    this.emit({ type: 'started', sessionId: this.value.sessionId, model: string(model), ...(typeof effort === 'string' ? { effort } : {}), ...(Array.isArray(skills) && skills.every(skill => typeof skill === 'string') ? { skills } : {}) })
  }

  tool(id: unknown, tool: string, input: unknown): void {
    if (typeof id !== 'string') { this.emit({ type: 'tool_call', tool, input: text(input) }); return }
    if (this.tools.has(id)) return
    const call = { tool, input: text(input), started: Date.now() }
    this.tools.set(id, call)
    this.emit({ type: 'tool_call', tool, input: call.input, callId: id, phase: 'start' })
  }

  hasTool(id: unknown): boolean { return typeof id === 'string' && this.tools.has(id) }

  toolResult(id: unknown, output: unknown, ok: boolean, raw: unknown): void {
    const call = typeof id === 'string' ? this.tools.get(id) : undefined
    if (call) {
      this.tools.delete(id as string)
      this.emit({ type: 'tool_call', tool: call.tool, input: call.input, callId: id as string,
        phase: 'end', durationMs: Math.max(0, Date.now() - call.started), output: text(output), ok })
    } else this.message(raw)
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

/**
 * 取 provider.apiKeyEnv 指向的密钥值：req.env 优先于 process.env，与子进程实际继承的环境一致。
 * 没配 apiKeyEnv 时两者都为空；配了但环境里没有时只有 name，交给调用方报明确错误（不打印值）。
 */
export function readProviderApiKey(req: HarnessRequest): { name?: string; value?: string } {
  const name = req.provider?.apiKeyEnv
  if (!name) return {}
  const value = req.env?.[name] ?? process.env[name]
  return value ? { name, value } : { name }
}
