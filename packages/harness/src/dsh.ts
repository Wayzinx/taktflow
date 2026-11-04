import type { HarnessAdapter, HarnessRequest, HarnessResult, Usage } from '@taktflow/core'
import { ParseState, object, string, number, readUsage, addUsage, promptWithInstructions } from './parse.js'
import type { EventSink, StreamParser } from './parse.js'
import { finalizeResult, runProcess } from './process.js'

export interface DshOptions { bin?: string; probeTimeoutMs?: number }

function sessionId(value: unknown): string | undefined {
  const session = object(value)
  return string(value) ?? string(session.id) ?? string(session.sessionId) ?? string(session.session_id)
}

function contentText(value: unknown): string | undefined {
  if (typeof value === 'string') return value
  if (!Array.isArray(value)) return undefined
  const texts = value.flatMap(entry => {
    const block = object(entry)
    return block.type === 'text' && typeof block.text === 'string' ? [block.text] : []
  })
  return texts.length ? texts.join('') : undefined
}

export function createDshParser(onEvent: EventSink = () => {}): StreamParser {
  const state = new ParseState(onEvent)
  let finalSeen = false
  let stepText = ''
  let usage: Usage | undefined
  let standaloneUsage: Usage | undefined
  let incompleteUsage = false
  const steps = new Set<string>()
  const pendingSteps = new Set<string>()
  const lastSteps = new Map<string, number>()
  return state.parser(data => {
    const session = sessionId(data.sessionId ?? data.session_id ?? data.session ?? (data.type === 'session' ? data.id : undefined))
    if (session !== undefined && session !== state.value.sessionId) state.started(session)
    if (data.type === 'session') {
      if (session === undefined) state.message(data)
    } else if (data.type === 'text' && typeof data.text === 'string') {
      stepText += data.text
      if (!finalSeen) state.value.finalText = stepText
      state.message(data.text, 'assistant')
    } else if (data.type === 'final' && typeof data.text === 'string') {
      finalSeen = true
      state.value.finalText = data.text
      state.message(data.text, 'assistant')
    } else if (data.type === 'assistant' || data.type === 'message') {
      const message = object(data.message)
      const role = data.type === 'assistant' ? 'assistant' : data.role ?? message.role
      const answer = contentText(message.content) ?? contentText(data.content) ?? string(data.text) ?? string(data.message) ?? string(message.text)
      if (role === 'assistant' && answer !== undefined) {
        if (!finalSeen) state.value.finalText = answer
        state.message(answer, 'assistant')
      } else state.message(data)
    } else if (data.type === 'usage') {
      const reported = readUsage(data.usage ?? data, true) ?? readUsage(data.usage ?? data)
      if (reported) {
        // 独立 usage 当作快照；有 step 用量时不与它相加，避免重复计费。
        standaloneUsage = reported
        onEvent({ type: 'usage', usage: reported })
      } else state.message(data)
    } else if (data.type === 'thinking') state.message(data.text ?? data)
    else if (data.type === 'tool_call') state.tool(data.callId, string(data.tool) ?? 'tool_call', data.input)
    else if (data.type === 'tool_result') state.toolResult(data.callId, data.result, data.status === 'completed', data)
    else if ((data.type === 'status' && (data.phase === 'step_start' || data.phase === 'turn_start'))
      || data.type === 'step_start' || data.type === 'turn_start') {
      // 一个 step 内的 text 是片段；新 step 尚未输出时保留上一条助手消息。
      stepText = ''
      if (data.phase === 'step_start' || data.type === 'step_start') {
        pendingSteps.add(`${String(data.turn ?? '')}:${number(data.step) ?? '?'}`)
      }
      state.message(data)
    } else if (data.type === 'status' && data.phase === 'step_end') {
      const step = number(data.step)
      const turn = String(data.turn ?? '')
      const key = step === undefined ? undefined : `${turn}:${step}`
      pendingSteps.delete(`${turn}:${step ?? '?'}`)
      if (key && steps.has(key)) return
      if (key) steps.add(key)
      if (step !== undefined) {
        const previous = lastSteps.get(turn) ?? 0
        if (step > previous + 1) incompleteUsage = true
        lastSteps.set(turn, step)
      }
      const stepUsage = readUsage(data.usage, true)
      if (!stepUsage) incompleteUsage = true
      else {
        usage = addUsage(usage ?? { inputTokens: 0, outputTokens: 0 }, stepUsage)
        onEvent({ type: 'usage', usage: stepUsage })
      }
    } else if (data.type === 'status' && data.phase === 'turn_end') {
      const reason = object(data.reason)
      if (reason.kind === 'error') state.fail(reason)
      else state.message(data)
    } else if (data.type === 'error') state.fail(data)
    else state.message(data)
  }, () => {
    const total = incompleteUsage || pendingSteps.size > 0 ? undefined : usage ?? standaloneUsage
    return { ...state.value, ...(total ? { usage: { ...total } } : {}) }
  })
}

const APP_BIN = '/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh'
const CACHE_MS = 10 * 60_000

export function createDshHarness(options: DshOptions = {}): HarnessAdapter {
  type Availability = Awaited<ReturnType<HarnessAdapter['available']>>
  let cache: { key: string; expires: number; value: Availability } | undefined
  let pending: { key: string; promise: Promise<Availability> } | undefined

  function candidates(req: HarnessRequest): string[] {
    return [...new Set([options.bin ?? req.env?.DSH_BIN ?? process.env.DSH_BIN, 'dsh', APP_BIN].filter((bin): bin is string => Boolean(bin)))]
  }

  async function run(req: HarnessRequest, onEvent: EventSink): Promise<HarnessResult> {
    const args = ['--profile', 'headless', '--json']
    if (req.sessionId) args.push('--session-id', req.sessionId)
    args.push('-')
    const bins = candidates(req)
    for (const [index, bin] of bins.entries()) {
      const parser = createDshParser(onEvent)
      const proc = await runProcess(bin, args, req, { stdin: promptWithInstructions(req), onLine: parser.onLine })
      if (proc.spawnErrorCode === 'ENOENT' && index < bins.length - 1) continue
      return finalizeResult(req, parser.result(), proc)
    }
    throw new Error('DSH 可执行文件候选列表为空')
  }

  async function probe(): Promise<Availability> {
    const result = await run({ prompt: 'Reply only OK.', cwd: process.cwd(), timeoutMs: options.probeTimeoutMs ?? 10_000 }, () => {})
    if (result.ok) return { ok: true }
    const reason = result.error || 'DeepSeek Harness 不可用'
    return { ok: false, reason: reason.includes('ACCOUNT_SIGN_IN_REQUIRED') ? '需要先登录 DeepSeek 账号' : reason }
  }

  return {
    id: 'dsh',
    displayName: 'DeepSeek Harness',
    async available() {
      const key = JSON.stringify([options.bin, process.env.DSH_BIN, process.env.PATH])
      if (cache?.key === key && cache.expires > Date.now()) return cache.value
      if (pending?.key === key) return pending.promise
      const promise = probe().then(value => {
        cache = { key, expires: Date.now() + CACHE_MS, value }
        return value
      }).finally(() => { if (pending?.promise === promise) pending = undefined })
      pending = { key, promise }
      return promise
    },
    run,
  }
}
