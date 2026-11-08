import type { HarnessCapabilities } from '@taktflow/core'
import type { HarnessAdapter } from '@taktflow/core'
import { ParseState, object, string, number, readUsage, readProviderApiKey } from './parse.js'
import type { EventSink, StreamParser } from './parse.js'
import { finalizeResult, runProcess } from './process.js'

export interface ClaudeCodeOptions { bin?: string; env?: Record<string, string> }

export function createClaudeCodeParser(onEvent: EventSink = () => {}): StreamParser {
  const state = new ParseState(onEvent)
  let completed = false
  return state.parser(data => {
    if (data.type === 'system' && data.subtype === 'init') {
      state.started(data.session_id, data.model, data.effort, data.skills)
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
  const capabilities: HarnessCapabilities = {
    toolPhases: true, readOnly: false, modelOverride: true, effortOverride: false,
    resume: true, structuredOutput: false, toolEvents: true, usage: true, cost: true,
    compactionEvents: false, customProvider: true, sandbox: false, mcp: true,
    providerProtocols: ['anthropic-messages'],
  }
  return {
    id: 'claude-code',
    displayName: 'Claude Code',
    capabilities,
    async available() {
      const proc = await runProcess(bin, ['--version'], { prompt: '', cwd: process.cwd(), env: options.env, timeoutMs: 5_000 })
      return proc.ok ? { ok: true } : { ok: false, reason: proc.error || proc.stderr || 'Claude Code 不可用' }
    },
    async run(req, onEvent) {
      if (options.env && Object.keys(options.env).length) req = { ...req, env: { ...options.env, ...req.env } }
      let processReq = req
      if (req.provider) {
        if (req.provider.protocol !== 'anthropic-messages') {
          return finalizeResult(req, { ok: false, finalText: '', error: 'Claude Code provider requires anthropic-messages protocol' }, { ok: true, stdout: '', stderr: '' })
        }
        const key = readProviderApiKey(req)
        if (key.name && !key.value) {
          return finalizeResult(req, { ok: false, finalText: '', error: `Claude Code provider missing API key environment variable: ${key.name}` }, { ok: true, stdout: '', stderr: '' })
        }
        processReq = { ...req, env: {
          ...req.env,
          ...(req.provider.baseURL === undefined ? {} : { ANTHROPIC_BASE_URL: req.provider.baseURL }),
          ...(key.value === undefined ? {} : { ANTHROPIC_AUTH_TOKEN: key.value }),
          ...(req.model === undefined ? {} : { ANTHROPIC_MODEL: req.model }),
        } }
      }
      const args = ['-p', '--output-format', 'stream-json', '--verbose']
      if (req.model) args.push('--model', req.model)
      if (req.sessionId) args.push('--resume', req.sessionId)
      if (req.systemAppend) args.push('--append-system-prompt', req.systemAppend)
      args.push('--permission-mode', 'bypassPermissions')
      const parser = createClaudeCodeParser(onEvent)
      const proc = await runProcess(bin, args, processReq, { stdin: req.prompt, onLine: parser.onLine })
      return finalizeResult(req, parser.result(), proc)
    },
  }
}
