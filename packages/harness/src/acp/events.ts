import type { HarnessCapabilities, HarnessEvent } from '@taktflow/core'
import { array, object, string, type ObjectValue } from './protocol.js'

const toolNames: Record<string, string> = {
  read: 'read', edit: 'edit', delete: 'edit', move: 'edit', search: 'search', execute: 'exec', fetch: 'fetch',
}

export class AcpEvents {
  finalText = ''
  configOptions: ObjectValue[] = []
  readonly calls = new Map<string, ObjectValue>()
  private readonly timings = new Map<string, { started: number; ended: boolean }>()
  private readonly compactions = new Map<string, ObjectValue>()

  constructor(private readonly emit: (event: HarnessEvent) => void, private readonly capabilities: HarnessCapabilities) {}

  audit(kind: string, data: unknown): void {
    this.emit({ type: 'message', role: 'system', text: `[ACP ${kind}] ${JSON.stringify(data)}` })
  }

  update(update: ObjectValue): void {
    switch (string(update.sessionUpdate)) {
      case 'agent_message_chunk': {
        const content = object(update.content)
        if (content.type !== 'text') { this.audit('content', content); break }
        const text = string(content.text)
        this.finalText += text
        this.emit({ type: 'message', role: 'assistant', text })
        break
      }
      case 'agent_thought_chunk': this.audit('thought', update.content); break
      case 'tool_call': case 'tool_call_update': this.tool(update); break
      case 'config_option_update': this.configure(update.configOptions); break
      case 'compaction_update': case 'compaction_summary_chunk': this.compaction(update); break
      // 当前 Usage 必填输入/输出 token，不能把 context.used 冒充输入 token。
      case 'usage_update': case 'plan': this.audit(string(update.sessionUpdate), update); break
      default: this.audit('update', update)
    }
  }

  configure(options: unknown): void {
    this.configOptions = options == null ? [] : array(options).map(object)
    this.capabilities.modelOverride = this.configOptions.some(option => option.type === 'select' && option.category === 'model')
    this.capabilities.effortOverride = this.configOptions.some(option => option.type === 'select' && option.category === 'thought_level')
  }

  private tool(update: ObjectValue): void {
    const id = string(update.toolCallId)
    const previous = this.calls.get(id)
    const merged = { ...previous }
    for (const [key, value] of Object.entries(update)) if (value != null) merged[key] = value
    this.calls.set(id, merged)
    const tool = toolNames[String(merged.kind)] ?? 'acp_tool'
    const input = JSON.stringify(merged.rawInput ?? { title: merged.title, locations: merged.locations })
    let timing = this.timings.get(id)
    if (!timing) {
      if (update.sessionUpdate !== 'tool_call') { this.audit('tool_call_update', merged); return }
      timing = { started: Date.now(), ended: false }
      this.timings.set(id, timing)
      this.capabilities.toolEvents = true
      this.emit({ type: 'tool_call', tool, input, callId: id, phase: 'start' })
    }
    if (timing.ended || !['completed', 'failed'].includes(String(merged.status))) return
    timing.ended = true
    this.capabilities.toolPhases = true
    this.emit({ type: 'tool_call', tool, input, callId: id, phase: 'end',
      durationMs: Math.max(0, Date.now() - timing.started), ok: merged.status === 'completed',
      ...(merged.rawOutput === undefined && merged.content === undefined ? {} : { output: JSON.stringify(merged.rawOutput ?? merged.content) }),
    })
  }

  private compaction(update: ObjectValue): void {
    const id = string(update.compactionId)
    const state = this.compactions.get(id) ?? { compactionId: id, status: 'in_progress' }
    if (update.sessionUpdate === 'compaction_summary_chunk') {
      state.summary = [...(Array.isArray(state.summary) ? state.summary : []), object(update.content)]
    } else {
      state.status = string(update.status)
      for (const key of ['summary', 'error', '_meta']) {
        if (!Object.hasOwn(update, key)) continue
        if (update[key] === null) delete state[key]
        else state[key] = update[key]
      }
    }
    this.compactions.set(id, state)
    // ACP 不提供 trigger / beforeTokens / afterTokens / dropped，不能合成 CompactionRecord。
    this.audit('compaction', state)
  }
}
