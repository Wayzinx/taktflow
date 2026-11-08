import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import type { CliHarnessConfig, HarnessAdapter, HarnessCapabilities, HarnessResult, Usage } from '@taktflow/core'
import { promptWithInstructions } from '../parse.js'
import type { EventSink, StreamParser } from '../parse.js'
import { finalizeResult, runProcess } from '../process.js'

const PROMPT_DIR_PREFIX = 'takt-cli-prompt-'
const PROBE_DIR_PREFIX = 'takt-cli-probe-'
const PROBE_TIMEOUT_MS = 5_000

// 诊断类事件只记事件和错误，不能进 finalText；工具事件同理。
const DIAGNOSTIC_TYPE = /(?:^|[._-])(?:error|fail|failed|failure|fatal|panic|warn|warning|debug|diag|diagnostic|log|info|trace|reasoning|thinking)(?:$|[._-])/i
const HARD_ERROR_TYPE = /(?:^|[._-])(?:error|fail|failed|failure|fatal|panic)(?:$|[._-])/i
const TOOL_TYPE = /tool/i
const NON_MESSAGE_TYPE = /^(?:usage|tokens?|metrics?|init|started|session|metadata|status|progress)(?:[._-]|$)/i
const DELTA_TYPE = /(?:^|[._-])delta(?:$|[._-])/i

export interface CliParserOptions {
  /** 兼容旧调用参数；请求模型不作为 started 的实际模型回报。 */
  model?: string
}

function dotGet(value: unknown, path: string | undefined): unknown {
  if (path === undefined || path === '') return undefined
  let current: unknown = value
  for (const key of path.split('.')) {
    if (current === null || typeof current !== 'object') return undefined
    if (!Object.hasOwn(current, key)) return undefined
    current = (current as Record<string, unknown>)[key]
  }
  return current
}

function readText(value: unknown): string | undefined {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (!Array.isArray(value)) return undefined
  const parts = value.flatMap(entry => {
    const block = entry !== null && typeof entry === 'object' ? (entry as Record<string, unknown>).text : undefined
    const part = typeof entry === 'string' ? entry : readText(block)
    return part === undefined ? [] : [part]
  })
  return parts.length > 0 ? parts.join('') : undefined
}

function serialize(value: unknown): string {
  if (typeof value === 'string') return value
  if (value === undefined) return ''
  return JSON.stringify(value) ?? String(value)
}

function tokenCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

function substitute(value: string, vars: Record<string, string>): string {
  // 单遍替换：插入的 prompt 内容不会被二次扫描，未知占位符保持字面。
  return value.replace(/\{\{([A-Za-z][A-Za-z0-9]*)\}\}/g, (match, name: string) => Object.hasOwn(vars, name) ? vars[name]! : match)
}

function resolvePromptVia(config: CliHarnessConfig): NonNullable<CliHarnessConfig['promptVia']> {
  if (config.promptVia) return config.promptVia
  if (config.command.some(arg => arg.includes('{{promptFile}}'))) return 'file'
  if (config.command.some(arg => arg.includes('{{prompt}}'))) return 'arg'
  return 'stdin'
}

export function createCliParser(config: CliHarnessConfig, onEvent: EventSink = () => {}, options: CliParserOptions = {}): StreamParser {
  const events = config.output.events
  const result: HarnessResult = { ok: true, finalText: '' }
  let finalSeen = false
  let started = false

  const fail = (message: string) => {
    result.ok = false
    result.error = [result.error, message].filter(Boolean).join('\n')
  }

  const handle = (data: Record<string, unknown>) => {
    const session = readText(dotGet(data, events?.sessionId))
    if (session !== undefined && session !== '' && session !== result.sessionId) {
      result.sessionId = session
      started = true
      onEvent({ type: 'started', sessionId: session, model: typeof data.model === 'string' ? data.model : undefined })
    } else if (!started) {
      started = true
      onEvent({ type: 'started', sessionId: result.sessionId, model: typeof data.model === 'string' ? data.model : undefined })
    }

    const type = readText(dotGet(data, events?.type))
    const diagnostic = type !== undefined && DIAGNOSTIC_TYPE.test(type)
    const mappedTool = readText(dotGet(data, events?.tool))
    const isTool = Boolean(mappedTool) || (type !== undefined && TOOL_TYPE.test(type))
    const inputTokens = events?.inputTokens === undefined ? undefined : tokenCount(dotGet(data, events.inputTokens))
    const outputTokens = events?.outputTokens === undefined ? undefined : tokenCount(dotGet(data, events.outputTokens))
    const text = readText(dotGet(data, events?.text)) ?? (diagnostic ? serialize(data) : undefined)
    const isFinal = !diagnostic && !isTool && events?.final !== undefined && dotGet(data, events.final.field) === events.final.equals

    if (mappedTool !== undefined && mappedTool !== '') {
      onEvent({ type: 'tool_call', tool: mappedTool, input: serialize(events?.toolInput === undefined ? undefined : dotGet(data, events.toolInput)) })
    }
    if (inputTokens !== undefined && outputTokens !== undefined) {
      const usage: Usage = { inputTokens, outputTokens }
      result.usage = usage
      onEvent({ type: 'usage', usage })
    }

    if (text !== undefined) {
      const isMessage = !diagnostic && !isTool && (isFinal || (
        inputTokens === undefined && outputTokens === undefined &&
        (type === undefined || !NON_MESSAGE_TYPE.test(type))
      ))
      if (isMessage) {
        onEvent({ type: 'message', role: 'assistant', text })
        if (isFinal) result.finalText = text
        else if (!finalSeen) result.finalText = type !== undefined && DELTA_TYPE.test(type) ? result.finalText + text : text
      } else if (!isTool) onEvent({ type: 'message', role: 'system', text })
    }
    if (isFinal) finalSeen = true
    if (!isTool && diagnostic && type !== undefined && HARD_ERROR_TYPE.test(type)) fail(serialize(data))
  }

  return {
    onLine(line) {
      const trimmed = line.trim()
      if (trimmed === '') return
      let value: unknown
      try {
        value = JSON.parse(trimmed) as unknown
      } catch {
        if (/^[{\[]/.test(trimmed)) fail(`Malformed protocol JSON: ${line}`)
        onEvent({ type: 'message', role: 'system', text: line })
        return
      }
      if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        onEvent({ type: 'message', role: 'system', text: line })
        return
      }
      handle(value as Record<string, unknown>)
    },
    result: () => events?.final && !finalSeen
      ? { ...result, ok: false, error: [result.error, 'Incomplete CLI stream: missing configured final event'].filter(Boolean).join('\n') }
      : { ...result },
  }
}

export function inferCliCapabilities(config: CliHarnessConfig): HarnessCapabilities {
  const events = config.output.format === 'jsonl' ? config.output.events : undefined
  const supportsResume = [...config.command, ...(config.resume?.args ?? [])].some(arg => arg.includes('{{sessionId}}'))
  // 显式声明只能关闭能力，不能把未实现的映射或原生功能声明为可用。
  return {
    toolPhases: false, readOnly: false, effortOverride: false,
    modelOverride: Boolean(config.model?.flag || config.model?.env || config.command.some(arg => arg.includes('{{model}}'))),
    resume: supportsResume && config.capabilities?.resume !== false,
    structuredOutput: false,
    toolEvents: Boolean(events?.tool) && config.capabilities?.toolEvents !== false,
    usage: Boolean(events?.inputTokens && events?.outputTokens) && config.capabilities?.usage !== false,
    cost: false,
    compactionEvents: false,
    customProvider: false,
    sandbox: false,
    mcp: false,
  }
}

export function createCliHarness(config: CliHarnessConfig, options: { projectDir?: string } = {}): HarnessAdapter {
  const projectDir = resolve(options.projectDir ?? process.cwd())
  const locateExecutable = (command: string) => !isAbsolute(command) && /[/\\]/.test(command) ? resolve(projectDir, command) : command
  const executable = config.command[0]
  if (!executable) throw new Error(`声明式 CLI harness ${config.id} 的 command 为空`)
  const promptVia = resolvePromptVia(config)
  const placeholder = promptVia === 'arg' ? '{{prompt}}' : '{{promptFile}}'
  if (promptVia !== 'stdin' && !config.command.some(arg => arg.includes(placeholder))) {
    throw new Error(`声明式 CLI harness ${config.id} 的 ${promptVia} 模式缺少 ${placeholder}`)
  }

  return {
    id: config.id,
    displayName: config.displayName ?? config.id,
    capabilities: inferCliCapabilities(config),
    async available() {
      const dir = await mkdtemp(join(tmpdir(), PROBE_DIR_PREFIX))
      try {
        const probe = config.available && config.available.length > 0 ? config.available : [executable, '--version']
        const command = probe.map(value => substitute(value, { cwd: projectDir, model: '', sessionId: '' }))
        const bin = command[0]
        if (!bin) return { ok: false, reason: `声明式 CLI harness ${config.id} 的 available 命令为空` }
        const proc = await runProcess(locateExecutable(bin), command.slice(1), { prompt: '', cwd: dir, timeoutMs: PROBE_TIMEOUT_MS, env: config.env }, {})
        if (proc.ok) return { ok: true }
        return { ok: false, reason: proc.error || proc.stderr.trim() || `${config.id} 不可用` }
      } finally {
        await rm(dir, { recursive: true, force: true })
      }
    },
    async run(req, onEvent) {
      if (req.provider) return { ok: false, finalText: '', error: `声明式 CLI harness ${config.id} 不支持 customProvider` }
      const prompt = promptWithInstructions(req)
      const vars: Record<string, string> = { prompt, cwd: req.cwd, model: req.model ?? '', sessionId: req.sessionId ?? '' }
      let promptDir: string | undefined
      try {
        if (promptVia === 'file') {
          promptDir = await mkdtemp(join(tmpdir(), PROMPT_DIR_PREFIX))
          const promptFile = join(promptDir, 'prompt.txt')
          await writeFile(promptFile, prompt, { encoding: 'utf8', mode: 0o600 })
          vars.promptFile = promptFile
        }

        const command = config.command.map(value => substitute(value, vars))
        const bin = command[0]
        if (!bin) return { ok: false, finalText: '', error: `声明式 CLI harness ${config.id} 的 command 为空` }
        const args = command.slice(1)
        if (req.model && config.model?.flag) args.push(config.model.flag, req.model)
        if (req.sessionId && config.resume?.args?.length) {
          args.push(...config.resume.args.map(value => substitute(value, vars)))
        }

        // 优先级：config.env < model.env（由 model 推导）< req.env（运行时最具体）。
        const env: Record<string, string> = { ...config.env }
        if (req.model && config.model?.env) env[config.model.env] = req.model
        Object.assign(env, req.env)

        const parser = createCliParser(config, onEvent, { model: req.model })
        const proc = await runProcess(locateExecutable(bin), args, { ...req, env }, {
          stdin: promptVia === 'stdin' ? prompt : undefined,
          onLine: config.output.format === 'jsonl' ? parser.onLine : undefined,
        })
        const parsed: HarnessResult = config.output.format === 'jsonl' ? parser.result() : { ok: true, finalText: proc.stdout }
        const result = finalizeResult(req, parsed, proc)
        if (result.sessionId === undefined && req.sessionId !== undefined) result.sessionId = req.sessionId
        if (config.output.format === 'text' && proc.stdout !== '') {
          onEvent(proc.ok
            ? { type: 'message', role: 'assistant', text: proc.stdout }
            : { type: 'message', role: 'system', text: proc.stdout })
        }
        return result
      } finally {
        if (promptDir !== undefined) await rm(promptDir, { recursive: true, force: true })
      }
    },
  }
}
