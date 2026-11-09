import type { HarnessCapabilities, HarnessEvent } from '@taktflow/core'
import { array, object, string, type ObjectValue } from './protocol.js'

const toolNames: Record<string, string> = {
  read: 'read', edit: 'edit', delete: 'edit', move: 'edit', search: 'search', execute: 'exec', fetch: 'fetch',
}

export class AcpEvents {
  finalText = ''
  configOptions: ObjectValue[] = []
  readonly calls = new Map<string, ObjectValue>()
  private readonly timings = new Map<string, { started: number; ended: boolean; announced: boolean }>()
  private readonly compactions = new Map<string, ObjectValue>()
  private thought = ''

  constructor(private readonly sink: (event: HarnessEvent) => void, private readonly capabilities: HarnessCapabilities) {}

  audit(kind: string, data: unknown): void {
    this.emit({ type: 'message', role: 'system', text: `[ACP ${kind}] ${JSON.stringify(data)}` })
  }

  /** 思考按 token 一条条推送（一个节点几万条）：连续的片段攒成一条，遇到别的事件、攒够 4000 字或运行结束时再记 */
  flush(): void {
    if (!this.thought) return
    const text = this.thought
    this.thought = ''
    this.sink({ type: 'message', role: 'system', text: `[ACP thought] ${JSON.stringify({ type: 'text', text })}` })
  }

  private emit(event: HarnessEvent): void {
    this.flush()
    this.sink(event)
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
      case 'agent_thought_chunk': {
        const content = object(update.content)
        if (content.type !== 'text') { this.audit('thought', content); break }
        this.thought += string(content.text)
        if (this.thought.length >= 4000) this.flush()
        break
      }
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
      timing = { started: Date.now(), ended: false, announced: false }
      this.timings.set(id, timing)
    }
    // claude-agent-acp 先发一个 rawInput 为空的 tool_call，下一条更新才带上命令 / 路径；等输入到了（或已不再 pending）再报开始
    const pendingInput = merged.status === 'pending' && isEmptyObject(merged.rawInput)
    if (!timing.announced && !pendingInput) {
      timing.announced = true
      this.capabilities.toolEvents = true
      this.emit({ type: 'tool_call', tool, input, callId: id, phase: 'start' })
    }
    if (!timing.announced) return
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

function isEmptyObject(value: unknown): boolean {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && Object.keys(value).length === 0
}
