import type { HarnessCapabilities } from '@taktflow/core'
import type { HarnessAdapter } from '@taktflow/core'
import { ParseState, object, string, text, readUsage, promptWithInstructions, readProviderApiKey } from './parse.js'
import type { EventSink, StreamParser } from './parse.js'
import { finalizeResult, runProcess } from './process.js'

export interface CodexOptions { bin?: string }

export function createCodexParser(onEvent: EventSink = () => {}): StreamParser {
  const state = new ParseState(onEvent)
  let completed = false
  return state.parser(data => {
    if (data.type === 'thread.started') state.started(data.thread_id)
    else if (data.type === 'item.started') {
      const item = object(data.item)
      if (['command_execution', 'file_change', 'mcp_tool_call', 'web_search'].includes(String(item.type))) {
        const tool = item.type === 'mcp_tool_call' ? [string(item.server), string(item.tool)].filter(Boolean).join('.') || 'mcp_tool_call' : String(item.type)
        state.tool(item.id, tool, item.command ?? item.changes ?? item.arguments ?? item.query)
      }
    } else if (data.type === 'item.completed') {
      const item = object(data.item)
      if (item.type === 'agent_message' && typeof item.text === 'string') {
        state.value.finalText = item.text
        state.message(item.text, 'assistant')
      } else if (item.type === 'reasoning') state.message(item.text ?? item)
      // 启动阶段的 item.error 可以是可恢复通知；整轮失败由顶层错误和终止事件判断。
      else if (item.type === 'error') state.message(item)
      else if (['command_execution', 'file_change', 'mcp_tool_call', 'web_search'].includes(String(item.type))) {
        const tool = item.type === 'mcp_tool_call' ? [string(item.server), string(item.tool)].filter(Boolean).join('.') || 'mcp_tool_call' : String(item.type)
        const output = item.aggregated_output ?? item.error ?? item.result ?? item
        const ok = item.status !== 'failed' && !item.error && (item.type !== 'command_execution' || item.exit_code === 0)
        if (state.hasTool(item.id)) state.toolResult(item.id, output, ok, data)
        else onEvent({ type: 'tool_call', tool, input: text(item.command ?? item.changes ?? item.arguments ?? item.query), output: text(output), ok })
      } else state.message(data)
    } else if (data.type === 'turn.completed') {
      completed = true
      const usage = readUsage(data.usage)
      if (usage) {
        state.value.usage = usage
        onEvent({ type: 'usage', usage })
      }
    } else if (data.type === 'error' || data.type === 'turn.failed') state.fail(data)
    else state.message(data)
  }, () => !completed && state.value.ok
    ? { ...state.value, ok: false, error: 'Incomplete Codex stream: missing terminal turn.completed event' }
    : { ...state.value })
}

// TOML 的 basic string 与 JSON 转义兼容，但 DEL 也必须显式转义。
function tomlString(value: string): string {
  return JSON.stringify(value).replace(/\u007f/g, '\\u007f')
}

export function createCodexHarness(options: CodexOptions = {}): HarnessAdapter {
  const bin = options.bin ?? 'codex'
  const capabilities: HarnessCapabilities = {
    toolPhases: true, readOnly: false, modelOverride: true, effortOverride: true,
    resume: true, structuredOutput: false, toolEvents: true, usage: true, cost: false,
    compactionEvents: false, customProvider: true, sandbox: false, mcp: true,
    providerProtocols: ['openai-chat', 'openai-responses'],
  }
  return {
    id: 'codex',
    displayName: 'Codex',
    capabilities,
    async available() {
      const proc = await runProcess(bin, ['--version'], { prompt: '', cwd: process.cwd(), timeoutMs: 5_000 })
      return proc.ok ? { ok: true } : { ok: false, reason: proc.error || proc.stderr || 'Codex 不可用' }
    },
    async run(req, onEvent) {
      const args = ['exec', '--json', '--skip-git-repo-check', '--sandbox', 'danger-full-access', '-C', req.cwd]
      if (req.provider) {
        const provider = req.provider
        if (provider.protocol !== 'openai-chat' && provider.protocol !== 'openai-responses') {
          return finalizeResult(req, { ok: false, finalText: '', error: 'Codex provider requires openai-chat or openai-responses protocol' }, { ok: true, stdout: '', stderr: '' })
        }
        // Codex override 按点拆分路径，不按 TOML quoted key 解析。
        if (!/^[A-Za-z0-9_-]+$/.test(provider.id)) {
          return finalizeResult(req, { ok: false, finalText: '', error: 'Codex provider id must match /^[A-Za-z0-9_-]+$/' }, { ok: true, stdout: '', stderr: '' })
        }
        const key = readProviderApiKey(req)
        if (key.name && !key.value) {
          return finalizeResult(req, { ok: false, finalText: '', error: `Codex provider missing API key environment variable: ${key.name}` }, { ok: true, stdout: '', stderr: '' })
        }
        const prefix = `model_providers.${provider.id}`
        args.push('-c', `model_provider=${tomlString(provider.id)}`, '-c', `${prefix}.name=${tomlString(provider.id)}`)
        if (provider.baseURL !== undefined) args.push('-c', `${prefix}.base_url=${tomlString(provider.baseURL)}`)
        if (key.name !== undefined) args.push('-c', `${prefix}.env_key=${tomlString(key.name)}`)
        args.push('-c', `${prefix}.wire_api=${tomlString(provider.protocol === 'openai-chat' ? 'chat' : 'responses')}`)
      }
      if (req.model) args.push('-m', req.model)
      if (req.effort) args.push('-c', `model_reasoning_effort="${req.effort}"`)
      // 0.159.2 的 resume 子命令不接收 -C/--sandbox，公共选项必须放在它之前。
      if (req.sessionId) args.push('resume', req.sessionId)
      args.push('-')
      const parser = createCodexParser(onEvent)
      const proc = await runProcess(bin, args, req, { stdin: promptWithInstructions(req), onLine: parser.onLine })
      return finalizeResult(req, parser.result(), proc)
    },
  }
}
