import { createDecipheriv, createHash, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage } from 'node:http'

export { createFeishuSender } from './feishu-wire-sender.js'

export interface FeishuApp {
  appId: string
  appSecret: string
  verificationToken: string
  encryptKey: string
  botOpenId: string
  tenantKey: string
  publicBaseUrl: string
}

export type FeishuEvent = { id: string; chatId: string; openId: string } & (
  { kind: 'message'; text: string } | { kind: 'action'; value: Record<string, string> }
)

type Callback = { challenge: string } | { event: FeishuEvent } | { ignored: true }
const MAX_BODY = 256 * 1024
const MAX_TEXT = 16 * 1024
const SIGNATURE_WINDOW_MS = 5 * 60 * 1000
const utf8 = new TextDecoder('utf-8', { fatal: true })

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function jsonObject(value: string | Buffer): Record<string, unknown> | undefined {
  try { return object(JSON.parse(typeof value === 'string' ? value : utf8.decode(value))) } catch { return undefined }
}

function idString(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,256}$/.test(value)
}

function equalToken(value: unknown, token: string): boolean {
  if (typeof value !== 'string' || !value || !token) return false
  const digest = (text: string) => createHash('sha256').update(text, 'utf16le').digest()
  return timingSafeEqual(digest(value), digest(token))
}

async function readRaw(req: IncomingMessage): Promise<Buffer | undefined> {
  const chunks: Buffer[] = []
  let bytes = 0
  try {
    for await (const chunk of req.iterator({ destroyOnReturn: false })) {
      if (!Buffer.isBuffer(chunk)) return undefined
      bytes += chunk.length
      if (bytes > MAX_BODY) return undefined
      chunks.push(chunk)
    }
    return Buffer.concat(chunks, bytes)
  } catch { return undefined }
}

function checkSignature(headers: IncomingMessage['headers'], body: Buffer, key: string): 'valid' | 'absent' | 'invalid' {
  const timestamp = headers['x-lark-request-timestamp']
  const nonce = headers['x-lark-request-nonce']
  const signature = headers['x-lark-signature']
  if (timestamp === undefined && nonce === undefined && signature === undefined) return 'absent'
  if (!key || typeof timestamp !== 'string' || !/^\d{1,12}$/.test(timestamp) ||
    Math.abs(Date.now() - Number(timestamp) * 1000) > SIGNATURE_WINDOW_MS ||
    typeof nonce !== 'string' || !/^[!-~]{1,256}$/.test(nonce) || nonce.includes(',') ||
    typeof signature !== 'string' || !/^[\da-f]{64}$/i.test(signature)) return 'invalid'
  const expected = createHash('sha256').update(timestamp + nonce + key).update(body).digest()
  return timingSafeEqual(Buffer.from(signature, 'hex'), expected) ? 'valid' : 'invalid'
}

function decrypt(value: unknown, key: string): Record<string, unknown> | undefined {
  if (typeof value !== 'string' || !key) return undefined
  const bytes = Buffer.from(value, 'base64')
  if (bytes.length < 32 || bytes.length % 16 !== 0 || bytes.toString('base64') !== value) return undefined
  try {
    const decipher = createDecipheriv('aes-256-cbc', createHash('sha256').update(key).digest(), bytes.subarray(0, 16))
    return jsonObject(Buffer.concat([decipher.update(bytes.subarray(16)), decipher.final()]))
  } catch { return undefined }
}

function messageText(message: Record<string, unknown>, botOpenId: string): string | undefined {
  if (typeof message.content !== 'string' || Buffer.byteLength(message.content) > 128 * 1024 || !Array.isArray(message.mentions)) return undefined
  const text = jsonObject(message.content)?.text
  if (typeof text !== 'string' || Buffer.byteLength(text) > MAX_TEXT) return undefined

  const botKeys = new Set<string>()
  const otherKeys = new Set<string>()
  for (const entry of message.mentions) {
    const mention = object(entry)
    if (typeof mention?.key !== 'string') continue
    const keys = object(mention.id)?.open_id === botOpenId ? botKeys : otherKeys
    keys.add(mention.key)
  }
  if (!botKeys.size) return undefined
  let mentioned = false
  const stripped = text.replace(/@_user_\d+/g, key => {
    if (!botKeys.has(key) || otherKeys.has(key)) return key
    mentioned = true
    return ''
  }).trim()
  return mentioned && stripped ? stripped : undefined
}

function messageEvent(event: Record<string, unknown>, app: FeishuApp, id: string): FeishuEvent | undefined {
  const sender = object(event.sender)
  const message = object(event.message)
  if (sender?.sender_type !== 'user' || message?.chat_type !== 'group' || message.message_type !== 'text' ||
    (sender.tenant_key !== undefined && sender.tenant_key !== app.tenantKey)) return undefined
  const openId = object(sender.sender_id)?.open_id
  const chatId = message.chat_id
  if (!idString(openId) || openId === app.botOpenId || !idString(chatId)) return undefined
  const text = messageText(message, app.botOpenId)
  return text === undefined ? undefined : { id, chatId, openId, kind: 'message', text }
}

function actionValue(input: unknown): Record<string, string> | undefined {
  const value = object(input)
  if (!value) return undefined
  const entries = Object.entries(value)
  if (entries.length > 32) return undefined
  const result: Record<string, string> = {}
  let bytes = 0
  for (const [key, field] of entries) {
    const keyBytes = Buffer.byteLength(key)
    if (!keyBytes || keyBytes > 64 || ['__proto__', 'constructor', 'prototype'].includes(key) || typeof field !== 'string') return undefined
    const fieldBytes = Buffer.byteLength(field)
    bytes += keyBytes + fieldBytes
    if (fieldBytes > 1024 || bytes > 8 * 1024) return undefined
    result[key] = field
  }
  return result
}

function actionEvent(event: Record<string, unknown>, app: FeishuApp, id: string): FeishuEvent | undefined {
  const operator = object(event.operator)
  const openId = operator?.open_id
  const chatId = object(event.context)?.open_chat_id
  if (operator?.tenant_key !== app.tenantKey || !idString(openId) || openId === app.botOpenId || !idString(chatId)) return undefined
  const value = actionValue(object(event.action)?.value)
  return value === undefined ? undefined : { id, chatId, openId, kind: 'action', value }
}

export async function readFeishuCallback(req: IncomingMessage, app: FeishuApp): Promise<Callback> {
  const ignored = { ignored: true } as const
  const body = await readRaw(req)
  if (!body) return ignored
  const signature = checkSignature(req.headers, body, app.encryptKey)
  if (signature === 'invalid') return ignored
  const envelope = jsonObject(body)
  if (!envelope) return ignored
  const encrypted = 'encrypt' in envelope
  if (encrypted && Object.keys(envelope).length !== 1) return ignored
  const payload = encrypted ? decrypt(envelope.encrypt, app.encryptKey) : envelope
  if (!payload) return ignored

  if (payload.type === 'url_verification') {
    const challenge = payload.challenge
    return typeof challenge === 'string' && challenge.length > 0 && Buffer.byteLength(challenge) <= 1024 &&
      equalToken(payload.token, app.verificationToken) ? { challenge } : ignored
  }
  if (!encrypted || signature !== 'valid' || payload.schema !== '2.0' || !app.appId || !app.tenantKey || !app.botOpenId) return ignored

  const header = object(payload.header)
  const event = object(payload.event)
  if (!event || !header || header.app_id !== app.appId || header.tenant_key !== app.tenantKey ||
    !equalToken(header.token, app.verificationToken) || !idString(header.event_id)) return ignored
  const parsed = header.event_type === 'im.message.receive_v1' ? messageEvent(event, app, header.event_id)
    : header.event_type === 'card.action.trigger' ? actionEvent(event, app, header.event_id) : undefined
  return parsed ? { event: parsed } : ignored
}
