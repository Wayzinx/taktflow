import type { HarnessAdapter, HarnessCapabilities, HarnessRequest, Usage } from '@taktflow/core'
import { addUsage, ParseState } from '../parse.js'
import type { EventSink, StreamParser } from '../parse.js'
import type { ProviderInjection, ProviderInjector } from '../provider-injection.js'
import { finalizeResult, runProcess } from '../process.js'

export interface StreamCliOptions { bin?: string; env?: Record<string, string> }

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
  env?: Record<string, string>
  capabilities?: HarnessCapabilities
  provider?: ProviderInjector
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
      ...(config.provider ? { customProvider: true, providerProtocols: config.provider.protocols } : {}),
    },
    async available() {
      const proc = await runProcess(config.bin, ['--version'], { prompt: '', cwd: process.cwd(), env: config.env, timeoutMs: 5_000 })
      return proc.ok ? { ok: true } : { ok: false, reason: proc.error || proc.stderr || `${config.displayName} 不可用` }
    },
    async run(req, onEvent) {
      if (config.env && Object.keys(config.env).length) req = { ...req, env: { ...config.env, ...req.env } }
      if (req.provider && !config.provider) return { ok: false, finalText: '', error: `${config.displayName} does not support customProvider` }
      if (req.sessionId) return { ok: false, finalText: '', error: `${config.displayName} does not support resume` }
      let injection: ProviderInjection | undefined
      try {
        injection = req.provider ? await config.provider!.prepare(req) : undefined
        if (injection) req = { ...req, env: { ...req.env, ...injection.env } }
        const parser = config.parser(onEvent)
        const { args, stdin } = config.command(req)
        const proc = await runProcess(config.bin, [...args, ...injection?.args ?? []], req, { stdin, onLine: parser.onLine })
        return finalizeResult(req, parser.result(), proc)
      } catch (error) {
        return finalizeResult(req, { ok: false, finalText: '', error: (error as Error).message }, { ok: true, stdout: '', stderr: '' })
      } finally { await injection?.cleanup?.() }
    },
  }
}
