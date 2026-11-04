import type { HarnessAdapter } from '@taktflow/core'
import { ParseState, object, string, number, readUsage } from './parse.js'
import type { EventSink, StreamParser } from './parse.js'
import { finalizeResult, runProcess } from './process.js'

export interface ClaudeCodeOptions { bin?: string }

export function createClaudeCodeParser(onEvent: EventSink = () => {}): StreamParser {
  const state = new ParseState(onEvent)
  let completed = false
  return state.parser(data => {
    if (data.type === 'system' && data.subtype === 'init') {
      state.started(data.session_id, data.model)
    } else if (data.type === 'assistant' || data.type === 'user') {
      const message = object(data.message)
      const blocks = Array.isArray(message.content) ? message.content : []
      let assistantText = ''
      for (const entry of blocks) {
        const block = object(entry)
        if (block.type === 'text' && typeof block.text === 'string') {
          state.message(block.text, data.type)
          if (data.type === 'assistant') assistantText += block.text
        } else if (block.type === 'tool_use') {
          state.tool(block.id, string(block.name) ?? 'tool_use', block.input)
        } else if (block.type === 'tool_result') {
          state.toolResult(block.tool_use_id, block.content, block.is_error !== true, block)
        } else state.message(block)
      }
      if (assistantText) state.value.finalText = assistantText
    } else if (data.type === 'result') {
      completed = true
      state.value.sessionId = string(data.session_id) ?? state.value.sessionId
      state.value.finalText = string(data.result) ?? state.value.finalText
      const usage = readUsage(data.usage)
      if (usage) {
        const costUsd = number(data.total_cost_usd)
        state.value.usage = { ...usage, ...(costUsd === undefined ? {} : { costUsd }) }
        onEvent({ type: 'usage', usage: state.value.usage })
      }
      if (data.is_error === true) state.fail(data)
    } else if (data.type === 'error') state.fail(data)
    else state.message(data)
  }, () => !completed && state.value.ok
    ? { ...state.value, ok: false, error: 'Incomplete Claude Code stream: missing terminal result event' }
    : { ...state.value })
}

export function createClaudeCodeHarness(options: ClaudeCodeOptions = {}): HarnessAdapter {
  const bin = options.bin ?? 'claude'
  return {
    id: 'claude-code',
    displayName: 'Claude Code',
    async available() {
      const proc = await runProcess(bin, ['--version'], { prompt: '', cwd: process.cwd(), timeoutMs: 5_000 })
      return proc.ok ? { ok: true } : { ok: false, reason: proc.error || proc.stderr || 'Claude Code 不可用' }
    },
    async run(req, onEvent) {
      const args = ['-p', '--output-format', 'stream-json', '--verbose']
      if (req.model) args.push('--model', req.model)
      if (req.sessionId) args.push('--resume', req.sessionId)
      if (req.systemAppend) args.push('--append-system-prompt', req.systemAppend)
      args.push('--permission-mode', 'bypassPermissions')
      const parser = createClaudeCodeParser(onEvent)
      const proc = await runProcess(bin, args, req, { stdin: req.prompt, onLine: parser.onLine })
      return finalizeResult(req, parser.result(), proc)
    },
  }
}
