import { setTimeout as delay } from 'node:timers/promises'
import type { ProviderConfig } from '@taktflow/core'

export interface ProviderHttpOptions {
  timeoutMs?: number
  probeTimeoutMs?: number
  retryDelayMs?: number
  resolveSecret?: (name: string) => string | undefined
}

export class ProviderHttpError extends Error {
  constructor(message: string, readonly status?: number, readonly schemaUnsupported = false) {
    super(`Provider request ${status === undefined ? '' : `HTTP ${status}: `}${message}`)
    this.name = 'ProviderHttpError'
  }
}

export function endpoint(config: ProviderConfig, protocol: 'openai-chat' | 'anthropic-messages'): URL {
  if (!config.baseURL) throw new Error('Provider baseURL is required')
  let url: URL
  try { url = new URL(config.baseURL) } catch { throw new Error('Invalid provider baseURL') }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) {
    throw new Error('Provider baseURL must be an HTTP(S) URL without credentials or fragment')
  }
  const path = url.pathname.replace(/\/+$/, '')
  if (protocol === 'anthropic-messages') {
    url.pathname = path.endsWith('/v1/messages') ? path : `${path.endsWith('/v1') ? path : `${path}/v1`}/messages`
  } else {
    url.pathname = path.endsWith('/chat/completions') ? path : `${path}/chat/completions`
  }
  return url
}

export function headers(config: ProviderConfig, protocol: string, resolveSecret: (name: string) => string | undefined = name => process.env[name]): Headers {
  const result = new Headers({ 'content-type': 'application/json' })
  if (protocol === 'anthropic-messages') result.set('anthropic-version', '2023-06-01')
  if (config.apiKeyEnv) {
    const key = resolveSecret(config.apiKeyEnv)
    if (!key?.trim()) throw new ProviderHttpError('API key environment variable is missing or empty')
    const authHeader = config.preset === 'azure-openai' ? 'api-key' : protocol === 'anthropic-messages' ? 'x-api-key' : 'authorization'
    result.set(authHeader, authHeader === 'authorization' ? `Bearer ${key}` : key)
  }
  // 显式 header 可覆盖认证方式（如 Azure 的 api-key）。
  for (const [name, value] of Object.entries(config.headers ?? {})) result.set(name, value)
  return result
}

function unsupportedSchema(status: number, body: string): boolean {
  if (status !== 400 && status !== 422) return false
  let error: Record<string, unknown>
  try {
    const parsed = JSON.parse(body)
    error = parsed.error && typeof parsed.error === 'object' ? parsed.error : parsed
  } catch { return false }
  if (!error || typeof error !== 'object') return false
  const message = typeof error.message === 'string' ? error.message.toLowerCase() : ''
  const param = typeof error.param === 'string' ? error.param.toLowerCase() : ''
  const code = typeof error.code === 'string' ? error.code.toLowerCase() : ''
  if (/invalid.*schema|schema.*invalid|additionalproperties|required propert|schema.*(?:type|keyword)/.test(message)) return false
  if (['response_format', 'response_format.type', 'json_schema', 'tool_choice'].includes(param) && ['unsupported_parameter', 'unsupported_value', 'not_supported'].includes(code)) return true
  return /(?:json_schema|response_format|structured outputs?|tool_choice|forced tool(?: use)?)['"`\s]*(?:is |are )?(?:not supported|unsupported|not available)/.test(message)
    || /(?:does not support|doesn't support|unsupported (?:parameter|value):?)\s*['"`]?(?:json_schema|response_format|structured outputs?|tool_choice|forced tool)/.test(message)
}

export class HttpOperation {
  private readonly controller = new AbortController()
  private readonly timer: ReturnType<typeof setTimeout>
  private readonly onAbort: () => void
  private retries = 0
  private timedOut = false
  private status?: number

  constructor(private readonly caller: AbortSignal | undefined, private readonly options: ProviderHttpOptions = {}) {
    const timeout = options.timeoutMs ?? 60_000
    if (!Number.isFinite(timeout) || timeout <= 0 || timeout > 2_147_483_647) throw new Error('Provider timeout must be a positive finite timer duration')
    this.onAbort = () => this.controller.abort()
    caller?.addEventListener('abort', this.onAbort, { once: true })
    if (caller?.aborted) this.onAbort()
    this.timer = setTimeout(() => { this.timedOut = true; this.controller.abort() }, timeout)
    this.timer.unref()
  }

  dispose(): void {
    clearTimeout(this.timer)
    this.caller?.removeEventListener('abort', this.onAbort)
  }

  async post(url: URL, config: ProviderConfig, protocol: string, payload: unknown): Promise<unknown> {
    try {
      const requestHeaders = headers(config, protocol, this.options.resolveSecret)
      const body = JSON.stringify(payload)
      for (;;) {
        this.controller.signal.throwIfAborted()
        this.status = undefined
        const response = await fetch(url, { method: 'POST', headers: requestHeaders, body, signal: this.controller.signal, redirect: 'manual' })
        this.status = response.status
        const text = await response.text()
        this.controller.signal.throwIfAborted()
        if (response.ok) {
          try { return JSON.parse(text) } catch { throw new ProviderHttpError('invalid JSON response', response.status) }
        }
        if ((response.status === 429 || response.status >= 500 && response.status <= 599) && this.retries < 3) {
          const ms = (this.options.retryDelayMs ?? 200) * 2 ** this.retries++
          await delay(ms, undefined, { signal: this.controller.signal })
          continue
        }
        // 不保存或传播服务端正文；其中可能回显认证 header、prompt 或 URL 中的密钥。
        throw new ProviderHttpError('request rejected', response.status, unsupportedSchema(response.status, text))
      }
    } catch (error) {
      if (this.controller.signal.aborted) throw new ProviderHttpError(this.timedOut ? 'timed out' : 'cancelled', this.status)
      if (error instanceof ProviderHttpError) throw error
      // fetch 和 JSON 序列化的原始异常也可能带敏感输入。
      throw new ProviderHttpError('failed; check address, credentials and request configuration', this.status)
    }
  }
}

export async function probe(config: ProviderConfig, protocol: 'openai-chat' | 'anthropic-messages', options: ProviderHttpOptions): Promise<{ ok: boolean; reason?: string }> {
  const controller = new AbortController()
  const timeout = Math.min(Math.max(options.probeTimeoutMs ?? 3_000, 1), 10_000)
  const timer = setTimeout(() => controller.abort(), timeout)
  timer.unref()
  try {
    const url = endpoint(config, protocol)
    const requestHeaders = headers(config, protocol, options.resolveSecret)
    // HEAD 不触发生成；404/405 仅代表端点未提供 HEAD，地址仍然可达。
    const response = await fetch(url, { method: 'HEAD', headers: requestHeaders, signal: controller.signal, redirect: 'manual' })
    await response.body?.cancel()
    if ([401, 403, 429].includes(response.status) || response.status >= 500 || response.status >= 300 && response.status < 400) {
      return { ok: false, reason: `Provider probe HTTP ${response.status}` }
    }
    return { ok: true }
  } catch {
    return { ok: false, reason: 'Provider probe failed: check baseURL, API key environment variable and address reachability' }
  } finally { clearTimeout(timer) }
}

export function invalidResponse(): never {
  throw new ProviderHttpError('invalid response structure', 200)
}

export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalidResponse()
  return value as Record<string, unknown>
}

export function token(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return invalidResponse()
  return value
}
