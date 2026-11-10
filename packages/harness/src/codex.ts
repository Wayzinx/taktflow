import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { toStrictSchema, dropNullOptionals } from '@taktflow/core'
import type { HarnessCapabilities } from '@taktflow/core'
import type { HarnessAdapter } from '@taktflow/core'
import { ParseState, object, string, text, readUsage, promptWithInstructions, readProviderApiKey } from './parse.js'
import type { EventSink, StreamParser } from './parse.js'
import { finalizeResult, runProcess } from './process.js'
import { listCliModels, parseCodexModels, parseTraeModels } from './model-list.js'

export interface CodexOptions { bin?: string; env?: Record<string, string> }

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
  return createCodexFamilyHarness('codex', 'Codex', 'codex', options)
}

export function createTraeHarness(options: CodexOptions = {}): HarnessAdapter {
  return createCodexFamilyHarness('trae', 'TRAE CLI', 'traecli', options)
}

function createCodexFamilyHarness(id: string, displayName: string, command: string, options: CodexOptions): HarnessAdapter {
  const bin = options.bin ?? command
  const capabilities: HarnessCapabilities = {
    toolPhases: true, readOnly: false, modelOverride: true, effortOverride: true,
    resume: true, structuredOutput: true, toolEvents: true, usage: true, cost: false,
    compactionEvents: false, customProvider: true, sandbox: false, mcp: true,
    providerProtocols: ['openai-responses'],
  }
  return {
    id, displayName,
    capabilities,
    async listModels() {
      const output = await listCliModels(bin, id === 'codex' ? ['debug', 'models'] : ['models'], options.env)
      return id === 'codex' ? parseCodexModels(output) : parseTraeModels(output)
    },
    async available() {
      const proc = await runProcess(bin, ['--version'], { prompt: '', cwd: process.cwd(), env: options.env, timeoutMs: 5_000 })
      return proc.ok ? { ok: true } : { ok: false, reason: proc.error || proc.stderr || 'Codex 不可用' }
    },
    async run(req, onEvent) {
      if (options.env && Object.keys(options.env).length) req = { ...req, env: { ...options.env, ...req.env } }
      const args = ['exec', '--json', '--skip-git-repo-check', '--sandbox', req.readOnly ? 'read-only' : 'danger-full-access', '-C', req.cwd]
      if (req.provider) {
        const provider = req.provider
        if (provider.protocol !== 'openai-responses') {
          return finalizeResult(req, { ok: false, finalText: '', error: `${displayName} provider 需要 openai-responses 协议` }, { ok: true, stdout: '', stderr: '' })
        }
        // Codex override 按点拆分路径，不按 TOML quoted key 解析。
        if (!/^[A-Za-z0-9_-]+$/.test(provider.id)) {
          return finalizeResult(req, { ok: false, finalText: '', error: `${displayName} provider id 只能包含字母、数字、下划线或短横线` }, { ok: true, stdout: '', stderr: '' })
        }
        const key = readProviderApiKey(req)
        if (key.name && !key.value) {
          return finalizeResult(req, { ok: false, finalText: '', error: `${displayName} 缺少密钥 ${key.name}` }, { ok: true, stdout: '', stderr: '' })
        }
        const prefix = `model_providers.${provider.id}`
        args.push('-c', `model_provider=${tomlString(provider.id)}`, '-c', `${prefix}.name=${tomlString(provider.id)}`)
        if (provider.baseURL !== undefined) args.push('-c', `${prefix}.base_url=${tomlString(provider.baseURL)}`)
        if (key.name !== undefined) args.push('-c', `${prefix}.env_key=${tomlString(key.name)}`)
        args.push('-c', `${prefix}.wire_api=${tomlString('responses')}`)
      }
      for (const [index, server] of (req.mcpServers ?? []).entries()) {
        if (!/^[A-Za-z0-9_-]+$/.test(server.name)) throw new Error('MCP 服务名不合法，请使用字母、数字、下划线或短横线')
        const prefix = `mcp_servers.${server.name}`, envName = `TAKT_MCP_TOKEN_${index}`
        // exec 的审批策略是 never：MCP 工具默认要审批，会被一律拒掉；这些工具由调用方自己把关（管家的写操作走提案）
        args.push('-c', `${prefix}.url=${tomlString(server.url)}`, '-c', `${prefix}.default_tools_approval_mode=${tomlString('approve')}`)
        const bearer = server.headers?.Authorization
        if (bearer) {
          if (!bearer.startsWith('Bearer ')) throw new Error('MCP 认证需要 Bearer 令牌，请重新发送消息')
          req = { ...req, env: { ...req.env, [envName]: bearer.slice(7) } }
          args.push('-c', `${prefix}.bearer_token_env_var=${tomlString(envName)}`)
        }
      }
      if (req.mcpServers?.length) args.push('-c', 'features.shell_tool=false')
      if (req.modelConfig?.contextWindow !== undefined) args.push('-c', `model_context_window=${req.modelConfig.contextWindow}`)
      if (req.model) args.push('-m', req.model)
      if (req.effort) args.push('-c', `model_reasoning_effort="${req.effort}"`)
      let strictSchema: Record<string, unknown> | undefined
      if (req.resultSchema) {
        try { strictSchema = toStrictSchema(req.resultSchema) }
        catch (error) {
          const reason = error instanceof Error ? error.message : String(error)
          onEvent({ type: 'message', role: 'system', text: `原生结构约束已降级为提示词与校验：${reason}` })
          req = { ...req, prompt: `${req.prompt}\n最后输出一个闭合的 json 代码块，满足：${JSON.stringify(req.resultSchema)}` }
        }
      }
      let schemaDir: string | undefined
      try {
        if (strictSchema) {
          schemaDir = await mkdtemp(join(tmpdir(), 'takt-output-schema-'))
          const file = join(schemaDir, 'schema.json')
          await writeFile(file, JSON.stringify(strictSchema), { mode: 0o600 })
          args.push('--output-schema', file)
        }
        // resume 子命令不接收 -C/--sandbox，公共选项必须放在它之前。
        if (req.sessionId) args.push('resume', req.sessionId)
        args.push('-')
        const parser = createCodexParser(onEvent)
        const proc = await runProcess(bin, args, req, { stdin: promptWithInstructions(req), onLine: parser.onLine })
        const parsed = parser.result()
        if (strictSchema && req.resultSchema) {
          try { parsed.structured = dropNullOptionals(JSON.parse(parsed.finalText), req.resultSchema) }
          catch { /* 格式错误留给统一校验与修正追问。 */ }
        }
        return finalizeResult(req, parsed, proc)
      } finally {
        if (schemaDir) await rm(schemaDir, { recursive: true, force: true })
      }
    },
  }
}
