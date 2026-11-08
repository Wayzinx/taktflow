import type { HarnessAdapter, HarnessCapabilities, HarnessRequest, Usage } from '@taktflow/core'
import { addUsage, ParseState } from '../parse.js'
import type { EventSink, StreamParser } from '../parse.js'
import { finalizeResult, runProcess } from '../process.js'

export interface StreamCliOptions { bin?: string }

export class StreamState extends ParseState {
  completed = false

  constructor(private readonly name: string, emit: EventSink) { super(emit) }

  usage(usage: Usage | undefined, cumulative = false): void {
    if (!usage) return
    const previous = this.value.usage
    this.value.usage = cumulative || !previous ? usage : addUsage(previous, usage)
    // harness.usage 按增量累加；累计快照只发新增量。
    const delta = cumulative && previous ? {
      inputTokens: Math.max(0, usage.inputTokens - previous.inputTokens),
      outputTokens: Math.max(0, usage.outputTokens - previous.outputTokens),
      ...(usage.cachedTokens === undefined ? {} : { cachedTokens: Math.max(0, usage.cachedTokens - (previous.cachedTokens ?? 0)) }),
      ...(usage.costUsd === undefined ? {} : { costUsd: Math.max(0, usage.costUsd - (previous.costUsd ?? 0)) }),
    } : usage
    this.emit({ type: 'usage', usage: delta })
  }

  answer(value: string, append = true): void {
    this.completed = false
    this.value.finalText = append ? this.value.finalText + value : value
    this.message(value, 'assistant')
  }

  result = () => !this.completed && this.value.ok
    ? { ...this.value, ok: false, error: `Incomplete ${this.name} stream: missing terminal event` }
    : { ...this.value }
}

interface StreamCliConfig {
  id: string
  displayName: string
  bin: string
  capabilities?: HarnessCapabilities
  parser: (sink: EventSink) => StreamParser
  command: (req: HarnessRequest) => { args: string[]; stdin?: string }
}

export function createStreamCliHarness(config: StreamCliConfig): HarnessAdapter {
  return {
    id: config.id,
    displayName: config.displayName,
    capabilities: {
      toolPhases: true, readOnly: false, modelOverride: true, effortOverride: false,
      resume: false, structuredOutput: false, toolEvents: true, usage: true,
      cost: false, compactionEvents: false, customProvider: false, sandbox: false, mcp: false,
      ...config.capabilities,
    },
    async available() {
      const proc = await runProcess(config.bin, ['--version'], { prompt: '', cwd: process.cwd(), timeoutMs: 5_000 })
      return proc.ok ? { ok: true } : { ok: false, reason: proc.error || proc.stderr || `${config.displayName} 不可用` }
    },
    async run(req, onEvent) {
      if (req.provider) return { ok: false, finalText: '', error: `${config.displayName} does not support customProvider` }
      if (req.sessionId) return { ok: false, finalText: '', error: `${config.displayName} does not support resume` }
      const parser = config.parser(onEvent)
      const { args, stdin } = config.command(req)
      const proc = await runProcess(config.bin, args, req, { stdin, onLine: parser.onLine })
      return finalizeResult(req, parser.result(), proc)
    },
  }
}
