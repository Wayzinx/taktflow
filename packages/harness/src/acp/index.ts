import { resolve } from 'node:path'
import type { AcpHarnessConfig, HarnessAdapter, HarnessCapabilities, HarnessRequest, HarnessResult } from '@taktflow/core'
import { promptWithInstructions } from '../parse.js'
import { extractJsonBlock } from '../process.js'
import { collectSecrets, createRedactor, redactValue } from '../redact.js'
import { AcpClient } from './client.js'
import { AcpEvents } from './events.js'
import { AcpFiles } from './files.js'
import { acpCommand } from './presets.js'
import { array, object, optionalObject, string, type ObjectValue } from './protocol.js'
import { clientRequests } from './requests.js'

export interface AcpOptions { projectDir?: string; handshakeTimeoutMs?: number; cancelTimeoutMs?: number; cacheMs?: number }
const CLIENT = { protocolVersion: 1, clientInfo: { name: 'taktflow', version: '0.0.0' },
  clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: false, session: { compaction: {} } } }

export function createAcpHarness(config: AcpHarnessConfig, options: AcpOptions = {}): HarnessAdapter {
  const command = acpCommand(config)
  if (options.projectDir && command[0]!.includes('/') && !command[0]!.startsWith('/')) command[0] = resolve(options.projectDir, command[0]!)
  // 不把 client 侧文件限制当作 agent 自有工具的沙箱保证。
  const capabilities: HarnessCapabilities = { resume: false, structuredOutput: false, toolEvents: false, toolPhases: false,
    usage: false, cost: false, compactionEvents: false, customProvider: false, sandbox: false, mcp: false,
    readOnly: false, modelOverride: false, effortOverride: false }
  type Availability = Awaited<ReturnType<HarnessAdapter['available']>>
  let cache: { expires: number; value: Promise<Availability> } | undefined

  async function initialize(client: AcpClient): Promise<ObjectValue> {
    const result = await client.request('initialize', CLIENT, options.handshakeTimeoutMs ?? 10_000)
    if (result.protocolVersion !== 1) throw new Error('ACP 协议版本不兼容，请使用支持 v1 的 agent')
    const agent = optionalObject(result.agentCapabilities)
    capabilities.resume = agent.loadSession === true || optionalObject(agent.sessionCapabilities).resume != null
    return result
  }

  return {
    id: config.id, displayName: config.displayName ?? config.id, capabilities,
    async available() {
      if (cache && cache.expires > Date.now()) return cache.value
      const value = (async (): Promise<Availability> => {
        const req = { prompt: '', cwd: options.projectDir ?? process.cwd(), env: config.env }
        const redact = createRedactor(collectSecrets(req))
        const client = new AcpClient(command, req, redact, () => {}, async () => { throw new Error('握手期间不接受会话请求') })
        try {
          const result = await initialize(client)
          const info = optionalObject(result.agentInfo)
          return { ok: true, detail: redact(JSON.stringify({ name: info.name, version: info.version,
            protocolVersion: result.protocolVersion, agentCapabilities: result.agentCapabilities, capabilities })) }
        } catch (error) { return { ok: false, reason: redact((error as Error).message) } }
        finally { await client.close() }
      })()
      cache = { expires: Infinity, value }
      void value.finally(() => { if (cache?.value === value) cache.expires = Date.now() + (options.cacheMs ?? 30_000) }).catch(() => {})
      return value
    },
    async run(input, onEvent) {
      const req: HarnessRequest = { ...input, env: { ...config.env, ...input.env } }
      const redact = createRedactor(collectSecrets(req))
      const events = new AcpEvents(event => onEvent(redactValue(event, redact)), capabilities)
      let sessionId = req.sessionId
      let client: AcpClient | undefined
      let timer: ReturnType<typeof setTimeout> | undefined
      let cancellationTimer: ReturnType<typeof setTimeout> | undefined
      const operations = new AbortController()
      let interrupted: string | undefined
      let prompting = false
      let replaying = false
      const cancel = (reason: string) => {
        if (interrupted) return
        interrupted = reason
        operations.abort()
        if (sessionId && prompting) {
          try { client?.notify('session/cancel', { sessionId }) } catch { /* 已退出时由 pending 请求报告。 */ }
          cancellationTimer = setTimeout(() => client?.fail(new Error(`${reason}；agent 未确认取消，将结束进程`)), options.cancelTimeoutMs ?? 1_000)
        } else client?.fail(new Error(reason))
      }
      const abort = () => cancel('ACP 运行已取消（cancelled）')
      try {
        if (req.signal?.aborted) throw new Error('ACP 启动前已取消（cancelled）')
        if (req.provider) throw new Error('ACP 不支持注入自定义 provider，请在 agent 自身配置中设置')
        if (req.sandbox) throw new Error('ACP 暂不支持沙箱传输，请使用本机运行或其他 harness')
        const operationRequest = { ...req, signal: operations.signal }
        const files = await AcpFiles.create(operationRequest)
        client = new AcpClient(command, req, redact, (method, params) => {
          if (method !== 'session/update') return
          if (params.sessionId !== sessionId) throw new Error('ACP 会话更新不匹配')
          const update = object(params.update)
          if (replaying) {
            if (update.sessionUpdate === 'config_option_update') events.configure(update.configOptions)
            events.audit('replay', update)
          } else events.update(update)
        }, clientRequests(config, operationRequest, files, events, () => sessionId))
        req.signal?.addEventListener('abort', abort, { once: true })
        timer = setTimeout(() => cancel('ACP 运行超时（timeout），请增大 timeoutMs 或检查 agent'), req.timeoutMs ?? 30 * 60_000)
        if (req.signal?.aborted) abort()
        const init = await initialize(client)
        const agent = optionalObject(init.agentCapabilities)
        const method = req.sessionId ? optionalObject(agent.sessionCapabilities).resume != null ? 'session/resume' : 'session/load' : 'session/new'
        if (req.sessionId && !capabilities.resume) throw new Error('该 ACP agent 未声明续会话能力，请创建新会话')
        replaying = method === 'session/load'
        const session = await client.request(method, { cwd: req.cwd, mcpServers: [], ...(req.sessionId ? { sessionId: req.sessionId } : {}) }, options.handshakeTimeoutMs ?? 10_000)
        replaying = false
        if (!req.sessionId) sessionId = string(session.sessionId)
        events.configure(session.configOptions ?? events.configOptions)
        for (const [category, requested] of [['model', req.model], ['thought_level', req.effort]] as const) {
          if (!requested) continue
          const option = events.configOptions.find(item => item.category === category && item.type === 'select')
          let applied = false
          if (option) {
            const choices = array(option.options).flatMap(value => {
              const item = object(value)
              return Array.isArray(item.options) ? item.options.map(object) : [item]
            })
            if (choices.some(item => item.value === requested)) {
              const response = await client.request('session/set_config_option', { sessionId, configId: string(option.id), value: requested })
              events.configure(response.configOptions)
              applied = events.configOptions.some(item => item.id === option.id && item.currentValue === requested)
            }
          }
          events.audit('config', { category, requested, applied })
        }
        const reported = (category: string) => {
          const value = events.configOptions.find(item => item.category === category)?.currentValue
          return typeof value === 'string' ? value : undefined
        }
        events.finalText = ''
        prompting = true
        onEvent(redactValue({ type: 'started', sessionId, model: reported('model'), effort: reported('thought_level') }, redact))
        if (interrupted) throw new Error(interrupted)
        const response = await client.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: promptWithInstructions(req) }] }, 0)
        const reason = string(response.stopReason)
        if (interrupted) throw new Error(interrupted)
        if (reason !== 'end_turn') {
          const reasons: Record<string, string> = { max_tokens: '达到 token 上限，请缩小任务或调整模型配置', max_turn_requests: '达到轮次上限，请缩小任务', refusal: 'agent 拒绝执行，请检查任务内容', cancelled: '运行已取消' }
          throw new Error(`ACP ${reason}：${reasons[reason] ?? '未知结束原因，请检查 agent 版本'}`)
        }
        return result(true)
      } catch (error) { return result(false, redact((error as Error).message)) }
      finally {
        operations.abort()
        clearTimeout(timer); clearTimeout(cancellationTimer)
        req.signal?.removeEventListener('abort', abort)
        await client?.close()
      }
      function result(ok: boolean, error?: string): HarnessResult {
        const finalText = redact(events.finalText)
        return { ok, finalText, ...(sessionId ? { sessionId: redact(sessionId) } : {}), ...(error ? { error } : {}),
          ...(req.resultSchema === undefined ? {} : { structured: extractJsonBlock(finalText) }) }
      }
    },
  }
}
