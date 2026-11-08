import { mkdir, open } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { HarnessAdapter, HarnessRequest, Usage } from '@taktflow/core'
import { number, object, string, text } from '../parse.js'
import type { EventSink, JsonObject, StreamParser } from '../parse.js'
import { collectSecrets, createRedactor, finalizeResult, runProcess } from '../process.js'
import type { ProcessResult } from '../process.js'
import { StreamState } from './stream-cli.js'

export interface PiOptions {
  bin?: string
  /** Pi 已配置的 provider 名；连接地址及凭据仍由 Pi 自己管理。 */
  provider?: string
}

function piUsage(value: unknown): Usage | undefined {
  const usage = object(value)
  const input = number(usage.input)
  const outputTokens = number(usage.output)
  if (input === undefined || outputTokens === undefined) return undefined
  const cachedTokens = number(usage.cacheRead)
  const costUsd = number(object(usage.cost).total)
  return {
    inputTokens: input + (cachedTokens ?? 0) + (number(usage.cacheWrite) ?? 0), outputTokens,
    ...(cachedTokens === undefined ? {} : { cachedTokens }),
    ...(costUsd === undefined ? {} : { costUsd }),
  }
}

function contentText(value: unknown): string {
  if (typeof value === 'string') return value
  return Array.isArray(value) ? value.map(object)
    .filter(part => part.type === 'text').map(part => string(part.text) ?? '').join('') : ''
}

async function runPiProcess(bin: string, args: string[], req: HarnessRequest, onJsonLine: (line: string) => void): Promise<ProcessResult> {
  const transcriptPath = req.env?.TAKT_TRANSCRIPT
  if (!transcriptPath || req.signal?.aborted) return runProcess(bin, args, req, { stdin: req.prompt, onJsonLine })
  const redact = createRedactor(collectSecrets(req))
  let transcript: Awaited<ReturnType<typeof open>> | undefined
  let result: ProcessResult = { ok: false, stdout: '', stderr: '' }
  const fail = (error: unknown) => {
    result.ok = false
    result.error = [result.error, redact(`Pi transcript failed: ${error instanceof Error ? error.message : String(error)}`)]
      .filter(Boolean).join('\n')
  }
  try {
    await mkdir(dirname(transcriptPath), { recursive: true })
    transcript = await open(transcriptPath, 'a')
    // 公共 runner 的 readline 也用于 transcript，会改变 Unicode 分隔符；Pi 单独保存已脱敏的原始 stdout。
    result = await runProcess(bin, args, { ...req, env: { ...req.env, TAKT_TRANSCRIPT: '' } }, { stdin: req.prompt, onJsonLine })
    result.transcriptPath = transcriptPath
    if (result.stdout) await transcript.appendFile(result.stdout.endsWith('\n') ? result.stdout : `${result.stdout}\n`, 'utf8')
  } catch (error) { fail(error) } finally {
    try { await transcript?.close() } catch (error) { fail(error) }
  }
  return result
}

// 协议依据：earendil-works/pi 的 docs/json.md、message-types.md、cli.md。
export function createPiParser(onEvent: EventSink = () => {}): StreamParser {
  const state = new StreamState('Pi', onEvent)
  const blocks = new Map<number, JsonObject>()
  const tools = new Set<string>()
  let header = false
  let messageOpen = false
  let lastReason: string | undefined
  let lastError: string | undefined
  let latestUsage: Usage | undefined

  const reconstructedText = () => [...blocks.entries()].sort(([a], [b]) => a - b)
    .filter(([, block]) => block.type === 'text').map(([, block]) => string(block.text) ?? '').join('')
  const tool = (value: unknown) => {
    const call = object(value)
    const id = string(call.id)
    const name = string(call.name)
    if (!id || !name || tools.has(id)) return
    tools.add(id)
    state.tool(id, name, call.arguments)
  }
  const endMessage = (message: JsonObject) => {
    state.completed = false
    if (message.role !== 'assistant') {
      if (message.role === 'user' || message.role === 'system') state.message(contentText(message.content), message.role)
      if (message.role === 'toolResult') state.usage(piUsage(message.usage))
      return
    }
    messageOpen = false
    // message_end 是权威快照；不再叠加之前的 delta，也不重复累加累计 usage。
    state.value.finalText = contentText(message.content)
    state.message(state.value.finalText, 'assistant')
    if (Array.isArray(message.content)) message.content.map(object).filter(part => part.type === 'toolCall').forEach(tool)
    state.usage(piUsage(message.usage) ?? latestUsage)
    latestUsage = undefined
    lastReason = string(message.stopReason)
    lastError = string(message.errorMessage)
  }
  const update = (data: JsonObject) => {
    if (!messageOpen) { state.fail('Pi message_update without assistant message_start'); return }
    latestUsage = piUsage(data.usage) ?? latestUsage
    const event = object(data.assistantMessageEvent)
    const index = number(event.contentIndex)
    if (index !== undefined) {
      const block = blocks.get(index) ?? {}
      switch (event.type) {
        case 'text_start': blocks.set(index, { type: 'text', text: '' }); break
        case 'text_delta': blocks.set(index, { type: 'text', text: (string(block.text) ?? '') + (string(event.delta) ?? '') }); break
        case 'text_end': blocks.set(index, { type: 'text', text: string(event.content) ?? '' }); break
        case 'thinking_start': blocks.set(index, { type: 'thinking', thinking: '' }); break
        case 'thinking_delta': blocks.set(index, { type: 'thinking', thinking: (string(block.thinking) ?? '') + (string(event.delta) ?? '') }); break
        case 'thinking_end': blocks.set(index, { type: 'thinking', thinking: string(event.content) ?? '' }); break
        case 'toolcall_start': blocks.set(index, { type: 'toolCall', id: event.id, name: event.toolName, serialized: '' }); break
        case 'toolcall_delta': blocks.set(index, { ...block, serialized: (string(block.serialized) ?? '') + (string(event.delta) ?? '') }); break
        case 'toolcall_end': blocks.set(index, object(event.toolCall)); break
      }
      state.value.finalText = reconstructedText()
    }
    if (event.type === 'done') endMessage(object(event.message))
    if (event.type === 'error') endMessage(object(event.error))
  }
  const handle = (data: JsonObject) => {
    if (data.type === 'session') {
      if (header || !string(data.id)) { state.fail('Invalid Pi session header'); return }
      header = true
      state.started(data.id)
      return
    }
    if (!header) { state.fail('Pi stream must begin with a session header'); return }
    switch (data.type) {
      case 'agent_start':
      case 'turn_start':
        state.completed = false
        lastReason = undefined
        lastError = undefined
        break
      case 'message_start': {
        state.completed = false
        const message = object(data.message)
        if (message.role !== 'assistant') break
        if (typeof message.model === 'string') state.started(state.value.sessionId, message.model)
        messageOpen = true
        latestUsage = undefined
        blocks.clear()
        if (Array.isArray(message.content)) message.content.forEach((part, index) => blocks.set(index, object(part)))
        state.value.finalText = reconstructedText()
        break
      }
      case 'message_update': update(data); break
      case 'message_end': endMessage(object(data.message)); break
      case 'tool_execution_start':
        state.completed = false
        tool({ id: data.toolCallId, name: data.toolName, arguments: data.args })
        break
      case 'tool_execution_end':
        state.toolResult(data.toolCallId, data.result, data.isError === false, data)
        break
      case 'agent_settled':
        state.completed = !messageOpen && lastReason === 'stop' && data.aborted === false
        if (!state.completed) state.fail(lastError ?? (data.aborted === true
          ? 'Pi run aborted' : `Pi run did not complete: ${lastReason ?? 'missing assistant message_end'}`))
        break
      case 'compaction_end': {
        const result = object(data.result)
        if (data.aborted === true || data.result === undefined) { state.message(data); break }
        const beforeTokens = number(result.tokensBefore)
        const afterTokens = number(result.estimatedTokensAfter)
        if (beforeTokens !== undefined && afterTokens !== undefined && typeof result.summary === 'string') {
          onEvent({ type: 'compacted', record: {
            at: new Date().toISOString(), trigger: data.reason === 'manual' ? 'manual' : 'auto',
            beforeTokens, afterTokens, summary: result.summary, dropped: [],
          } })
        } else state.message(data)
        state.usage(piUsage(result.usage))
        break
      }
      case 'auto_retry_end':
        if (data.success === false) state.fail(data.finalError ?? 'Pi automatic retry failed')
        break
      case 'error': state.fail(data); break
      // 这些事件重复携带最终消息，不能重复输出或计费。
      case 'turn_end':
      case 'agent_end':
      case 'tool_execution_update': break
      default: state.message(data)
    }
  }
  return {
    onLine(line) {
      if (!line.trim()) return
      let data: unknown
      try { data = JSON.parse(line) as unknown } catch { state.fail(`Malformed Pi JSONL: ${line}`); return }
      if (typeof object(data).type !== 'string') { state.fail(`Invalid Pi event: ${text(data)}`); return }
      handle(object(data))
    },
    result: state.result,
  }
}

export function createPiHarness(options: PiOptions = {}): HarnessAdapter {
  const bin = options.bin ?? 'pi'
  return {
    id: 'pi', displayName: 'Pi',
    capabilities: {
      toolPhases: true, readOnly: false, modelOverride: true, effortOverride: true,
      resume: true, structuredOutput: false, toolEvents: true, usage: true, cost: true,
      compactionEvents: true, customProvider: false, sandbox: false, mcp: true,
    },
    async available() {
      const proc = await runProcess(bin, ['--version'], { prompt: '', cwd: process.cwd(), timeoutMs: 5_000 })
      return proc.ok ? { ok: true } : { ok: false, reason: proc.error || proc.stderr || 'Pi 不可用' }
    },
    async run(req, onEvent) {
      if (req.provider) return { ok: false, finalText: '', error: 'Pi does not support customProvider connection overrides; configure providers in Pi and select provider/model via model' }
      if (options.provider && !req.model) return { ok: false, finalText: '', error: 'Pi --provider requires --model' }
      const args = ['--mode', 'json',
        ...(req.model ? ['--model', req.model] : []),
        ...(options.provider ? ['--provider', options.provider] : []),
        ...(req.sessionId ? ['--session', req.sessionId] : []),
        ...(req.effort ? ['--thinking', req.effort] : []),
        ...(req.systemAppend ? ['--append-system-prompt', req.systemAppend] : []),
      ]
      const parser = createPiParser(onEvent)
      // 按 LF 实时处理完整 JSON 行，保留字符串内的 Unicode 分隔符。
      const proc = await runPiProcess(bin, args, req, parser.onLine)
      return finalizeResult(req, parser.result(), proc)
    },
  }
}
