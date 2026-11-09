import { resolve } from 'node:path'
import type { AcpHarnessConfig, HarnessAdapter, HarnessCapabilities, HarnessRequest, HarnessResult } from '@taktflow/core'
import { promptWithInstructions, readProviderApiKey } from '../parse.js'
import { extractJsonBlock } from '../process.js'
import { collectSecrets, createRedactor, redactValue } from '../redact.js'
import { AcpClient } from './client.js'
import { AcpEvents } from './events.js'
import { AcpFiles } from './files.js'
import { ACP_PROVIDER_ENV, acpCommand, acpSessionMeta } from './presets.js'
import { array, object, optionalObject, string, type ObjectValue } from './protocol.js'
import { clientRequests } from './requests.js'

export interface AcpOptions { projectDir?: string; handshakeTimeoutMs?: number; cancelTimeoutMs?: number; cacheMs?: number }
// npx 启动的 agent 冷启动要解析依赖，负载高时 10 秒不够
const HANDSHAKE_MS = 30_000
const CLIENT = { protocolVersion: 1, clientInfo: { name: 'taktflow', version: '0.0.0' },
  clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: false, session: { compaction: {} } } }

export function createAcpHarness(config: AcpHarnessConfig, options: AcpOptions = {}): HarnessAdapter {
  const command = acpCommand(config)
  if (options.projectDir && command[0]!.includes('/') && !command[0]!.startsWith('/')) command[0] = resolve(options.projectDir, command[0]!)
  const providerEnv = config.preset && Object.hasOwn(ACP_PROVIDER_ENV, config.preset) ? ACP_PROVIDER_ENV[config.preset] : undefined
  // 不把 client 侧文件限制当作 agent 自有工具的沙箱保证。
  const capabilities: HarnessCapabilities = { resume: false, structuredOutput: false, toolEvents: false, toolPhases: false,
    usage: false, cost: false, compactionEvents: false, customProvider: Boolean(providerEnv), sandbox: false, mcp: false,
    readOnly: false, modelOverride: false, effortOverride: false, ...(providerEnv ? { providerProtocols: providerEnv.protocols } : {}) }
  type Availability = Awaited<ReturnType<HarnessAdapter['available']>>
  let cache: { expires: number; value: Promise<Availability> } | undefined

  async function initialize(client: AcpClient): Promise<ObjectValue> {
    const result = await client.request('initialize', CLIENT, options.handshakeTimeoutMs ?? HANDSHAKE_MS)
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
      // 本机"沙箱"只是在宿主上起进程：并入它的环境变量照常跑；真隔离（bwrap / docker）下面明确拒绝
      const local = input.sandbox?.provider === 'local'
      const base: HarnessRequest = { ...input, ...(local ? { sandbox: undefined } : {}), env: { ...config.env, ...(local ? input.sandbox!.spec.env : {}), ...input.env } }
      const key = base.provider ? readProviderApiKey(base) : {}
      const req: HarnessRequest = base.provider && providerEnv ? { ...base, env: { ...base.env, ...providerEnv.env(base, key.value) } } : base
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
        if (req.provider && !providerEnv) throw new Error('这个 ACP agent 不支持改接模型 API，请在 agent 自身配置中设置')
        if (key.name && !key.value) throw new Error(`缺少模型 API 密钥：环境变量 ${key.name} 未设置`)
        if (req.sandbox) throw new Error(`ACP 暂不支持 ${req.sandbox.provider} 沙箱，请改用本机运行或其他 harness`)
        const operationRequest = { ...req, signal: operations.signal }
        const files = await AcpFiles.create(operationRequest)
        client = new AcpClient(command, req, redact, (method, params) => {
          if (method !== 'session/update') return
          const update = object(params.update)
          if (params.sessionId !== sessionId) {
            throw new Error(`ACP 会话更新不匹配：收到会话 ${String(params.sessionId)} 的 ${String(update.sessionUpdate)}，当前会话 ${sessionId ?? '尚未建立'}`)
          }
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
        const meta = acpSessionMeta(config.preset, req.env)
        const session = await client.request(method, { cwd: req.cwd, mcpServers: [], ...(req.sessionId ? { sessionId: req.sessionId } : {}), ...(meta ? { _meta: meta } : {}) }, options.handshakeTimeoutMs ?? HANDSHAKE_MS)
        replaying = false
        if (!req.sessionId) sessionId = string(session.sessionId)
        events.configure(session.configOptions ?? events.configOptions)
        // 改接别家 API 时模型已经由环境变量指定；agent 的模型选项是它自己的别名（opus / sonnet …），不再去设
        for (const [category, requested] of [['model', req.provider ? undefined : req.model], ['thought_level', req.effort]] as const) {
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
        onEvent(redactValue({ type: 'started', sessionId, model: req.provider ? req.model : reported('model'), effort: reported('thought_level') }, redact))
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
        events.flush()
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
