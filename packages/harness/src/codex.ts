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
    else if (data.type === 'item.completed') {
      const item = object(data.item)
      if (item.type === 'agent_message' && typeof item.text === 'string') {
        state.value.finalText = item.text
        state.message(item.text, 'assistant')
      } else if (item.type === 'reasoning') state.message(item.text ?? item)
      // 启动阶段的 item.error 可以是可恢复通知；整轮失败由顶层错误和终止事件判断。
      else if (item.type === 'error') state.message(item)
      else if (item.type === 'command_execution') {
        onEvent({ type: 'tool_call', tool: 'command_execution', input: text(item.command),
          output: text(item.aggregated_output), ok: item.status !== 'failed' && item.exit_code === 0 })
      } else if (item.type === 'file_change') {
        onEvent({ type: 'tool_call', tool: 'file_change', input: text(item.changes),
          output: text(item), ok: item.status === 'completed' })
      } else if (item.type === 'mcp_tool_call') {
        onEvent({ type: 'tool_call', tool: [string(item.server), string(item.tool)].filter(Boolean).join('.') || 'mcp_tool_call',
          input: text(item.arguments), output: text(item.error ?? item.result), ok: item.status === 'completed' && !item.error })
      } else if (item.type === 'web_search') {
        onEvent({ type: 'tool_call', tool: 'web_search', input: text(item.query), output: text(item) })
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
