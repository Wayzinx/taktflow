import { createHash } from 'node:crypto'
import type { FeishuApp } from './feishu-wire.js'

const API = 'https://open.feishu.cn/open-apis'
const REQUEST_TIMEOUT_MS = 5_000

interface Message { type: 'text' | 'interactive'; content: Record<string, unknown> }

function messageUuid(appId: string, chatId: string, dedupId: string): string {
  const hex = createHash('sha256').update(JSON.stringify([appId, chatId, dedupId])).digest('hex')
  const variant = ((Number.parseInt(hex.charAt(16), 16) & 3) | 8).toString(16)
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}

async function post(fetcher: typeof fetch, path: string, body: string, operation: string, token?: string): Promise<Record<string, unknown>> {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { reject(new Error()); controller.abort() }, REQUEST_TIMEOUT_MS)
  })
  try {
    const headers: Record<string, string> = { 'content-type': 'application/json; charset=utf-8' }
    if (token) headers.authorization = `Bearer ${token}`
    const response = await Promise.race([
      fetcher(API + path, { method: 'POST', headers, body, signal: controller.signal, redirect: 'error' }), timeout,
    ])
    if (!response.ok || response.redirected) {
      void response.body?.cancel().catch(() => undefined)
      throw new Error()
    }
    const data: unknown = await Promise.race([response.json(), timeout])
    if (!data || typeof data !== 'object' || !('code' in data) || data.code !== 0) throw new Error()
    return data as Record<string, unknown>
  } catch {
    throw new Error(`飞书${operation}请求失败`)
  } finally {
    clearTimeout(timer)
  }
}

export function createFeishuSender(app: FeishuApp, fetcher: typeof fetch = fetch) {
  const { appId, appSecret } = app
  let cached: { token: string; refreshAt: number } | undefined
  let pending: Promise<string> | undefined

  async function fetchToken(): Promise<string> {
    const started = Date.now()
    const { tenant_access_token: token, expire } = await post(fetcher, '/auth/v3/tenant_access_token/internal',
      JSON.stringify({ app_id: appId, app_secret: appSecret }), '获取租户令牌')
    if (typeof token !== 'string' || token.length > 4096 || !/^[A-Za-z0-9._~+/\-]+=*$/.test(token) ||
      typeof expire !== 'number' || !Number.isSafeInteger(expire) || expire <= 0) throw new Error('飞书租户令牌响应格式不正确')
    const ttl = expire * 1000
    cached = { token, refreshAt: started + ttl - Math.min(60_000, ttl / 10) }
    return token
  }

  function tenantToken(): Promise<string> {
    if (cached && Date.now() < cached.refreshAt) return Promise.resolve(cached.token)
    pending ??= fetchToken().finally(() => { pending = undefined })
    return pending
  }

  return async (chatId: string, message: Message, dedupId: string): Promise<void> => {
    if (!chatId.trim() || !dedupId.trim()) throw new Error('飞书发消息需要群聊 ID 和去重 ID')
    let body: string
    try {
      const content = JSON.stringify(message.content)
      if (content === undefined) throw new Error()
      body = JSON.stringify({ receive_id: chatId, msg_type: message.type, content, uuid: messageUuid(appId, chatId, dedupId) })
    } catch { throw new Error('飞书消息无法序列化') }
    await post(fetcher, '/im/v1/messages?receive_id_type=chat_id', body, '发消息', await tenantToken())
  }
}
