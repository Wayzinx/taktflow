import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { HarnessCapabilities } from '@taktflow/core'
import type { HarnessAdapter } from '@taktflow/core'
import { ParseState, object, string, number, readUsage, readProviderApiKey } from './parse.js'
import type { EventSink, JsonObject, StreamParser } from './parse.js'
import { claudeProviderEnv } from './claude-env.js'
import { finalizeResult, runProcess } from './process.js'

export interface ClaudeCodeOptions { bin?: string; env?: Record<string, string> }

/** is_error 的 result 只留人能读的部分（HTTP 状态、result 文本、errors）；一样都取不到才整段保留。 */
function resultError(data: JsonObject): unknown {
  const errors = Array.isArray(data.errors)
    ? data.errors.map(entry => typeof entry === 'string' ? entry : [object(entry).code, string(object(entry).message)].filter(x => x !== undefined).join(' ')).filter(Boolean)
    : []
  const status = number(data.api_error_status)
  const parts = [status === undefined ? undefined : `HTTP ${status}`, string(data.result)?.trim(), ...errors].filter(Boolean)
  return parts.length ? `Claude Code：${parts.join('；')}` : data
}

/**
 * 只是进度计数的 system 行：新版 Claude Code 每多想一个 token 就发一条 thinking_tokens，
 * 一个评审节点能刷出几十万条，原样记成消息会把事件日志撑到上百 MB、运行页每次刷新都重绘。
 */
const NOISE_SYSTEM = new Set(['thinking_tokens'])

export function createClaudeCodeParser(onEvent: EventSink = () => {}): StreamParser {
  const state = new ParseState(onEvent)
  let completed = false
  return state.parser(data => {
    if (data.type === 'system' && data.subtype === 'init') {
      state.started(data.session_id, data.model, data.effort, data.skills)
    } else if (data.type === 'system' && NOISE_SYSTEM.has(string(data.subtype) ?? '')) {
      return
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
      if (data.structured_output !== undefined && data.structured_output !== null) state.value.structured = data.structured_output
      const usage = readUsage(data.usage)
      if (usage) {
        const costUsd = number(data.total_cost_usd)
        state.value.usage = { ...usage, ...(costUsd === undefined ? {} : { costUsd }) }
        onEvent({ type: 'usage', usage: state.value.usage })
      }
      if (data.is_error === true) state.fail(resultError(data))
    } else if (data.type === 'error') state.fail(data)
    else state.message(data)
  }, () => !completed && state.value.ok
    ? { ...state.value, ok: false, error: 'Incomplete Claude Code stream: missing terminal result event' }
    : { ...state.value })
}

function withoutCost(onEvent: EventSink): EventSink {
  return event => {
    if (event.type !== 'usage' || event.usage.costUsd === undefined) return onEvent(event)
    const { costUsd: _cost, ...usage } = event.usage
    onEvent({ ...event, usage })
  }
}

export function createClaudeCodeHarness(options: ClaudeCodeOptions = {}): HarnessAdapter {
  const bin = options.bin ?? 'claude'
  const capabilities: HarnessCapabilities = {
    toolPhases: true, readOnly: false, modelOverride: true, effortOverride: false,
    resume: true, structuredOutput: true, toolEvents: true, usage: true, cost: true,
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
        processReq = { ...req, env: { ...req.env, ...claudeProviderEnv(req, key.value) } }
      }
      const args = ['-p', '--output-format', 'stream-json', '--verbose']
      if (req.resultSchema) args.push('--json-schema', JSON.stringify(req.resultSchema))
      // 只读调用（快照评审、修正追问）仍要能读冻结材料：只留读类工具；接 MCP 时下面整体换成 MCP 工具
      if (req.readOnly && !req.mcpServers?.length) args.push('--tools', 'Read,Grep,Glob')
      if (req.model) args.push('--model', req.model)
      if (req.sessionId) args.push('--resume', req.sessionId)
      if (req.systemAppend) args.push('--append-system-prompt', req.systemAppend)
      args.push('--permission-mode', 'bypassPermissions')
      // 流水线里的 agent 不加载个人 ~/.claude 设置（钩子、插件、env、个人 skills）：结果可复现，也不会被个人钩子拖到超时
      args.push('--setting-sources', processReq.env?.TAKT_CLAUDE_SETTING_SOURCES ?? process.env.TAKT_CLAUDE_SETTING_SOURCES ?? 'project,local')
      // 接别家 API 时 Claude Code 仍按 Anthropic 价目算 total_cost_usd，不能当真；成本由引擎按模型价格算
      const sink = req.provider ? withoutCost(onEvent) : onEvent
      const parser = createClaudeCodeParser(sink)
      // 自动记忆会往个人 ~/.claude/projects 写东西，流水线里关掉（env 里显式给了就按给的）
      processReq = { ...processReq, env: { CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1', ...processReq.env } }
      let mcpDir: string | undefined
      let proc: Awaited<ReturnType<typeof runProcess>>
      try {
        if (req.mcpServers?.length) {
          mcpDir = await mkdtemp(join(tmpdir(), 'takt-mcp-'))
          const file = join(mcpDir, 'mcp.json')
          await writeFile(file, JSON.stringify({ mcpServers: Object.fromEntries(req.mcpServers.map(server => [server.name, { type: 'http', url: server.url, headers: server.headers }])) }), { mode: 0o600 })
          args.push('--mcp-config', file, '--strict-mcp-config', '--allowedTools', 'mcp__takt__*', '--tools', '')
        }
        proc = await runProcess(bin, args, processReq, { stdin: req.prompt, onLine: parser.onLine })
      } finally {
        if (mcpDir) await rm(mcpDir, { recursive: true, force: true })
      }
      const result = finalizeResult(req, parser.result(), proc)
      if (req.provider && result.usage) delete result.usage.costUsd
      // 别家模型名 Claude Code 不认识，会往 stderr 打一行诊断；不是错误原因
      if (result.error) result.error = result.error.split('\n').filter(line => !line.startsWith('[claude-code:unrecognized_model]')).join('\n') || undefined
      return result
    },
  }
}
