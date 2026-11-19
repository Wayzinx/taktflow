import { createCipheriv, createHash } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import { Readable } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { readFeishuCallback, type FeishuApp } from './feishu-wire.js'

const app: FeishuApp = {
  appId: 'cli_demo', appSecret: 'app-secret', verificationToken: 'verify-this', encryptKey: '密钥-demo',
  botOpenId: 'ou_bot', tenantKey: 'tenant_demo', publicBaseUrl: 'https://hub.example.test',
}
const iv = Buffer.from('51d245d8c740ec24ed882a5a265c9416', 'hex')
const ignored = { ignored: true }

function envelope(payload: unknown, key = app.encryptKey): Buffer {
  const cipher = createCipheriv('aes-256-cbc', createHash('sha256').update(key).digest(), iv)
  const encrypt = Buffer.concat([iv, cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()]).toString('base64')
  return Buffer.from(`{\n  "encrypt" : "${encrypt}"\n}\n`)
}

function signingHeaders(body: Buffer, offset = 0, key = app.encryptKey): IncomingMessage['headers'] {
  const timestamp = String(Math.floor(Date.now() / 1000) + offset)
  const nonce = '9223372036854775807'
  const signature = createHash('sha256').update(Buffer.concat([Buffer.from(timestamp + nonce + key), body])).digest('hex')
  return { 'x-lark-request-timestamp': timestamp, 'x-lark-request-nonce': nonce, 'x-lark-signature': signature }
}

function callback(body: Buffer, headers: IncomingMessage['headers'] = {}, config = app) {
  const request = Object.assign(Readable.from([body.subarray(0, 20), body.subarray(20)]), { headers })
  return readFeishuCallback(request as unknown as IncomingMessage, config)
}

function signed(payload: unknown) {
  const body = envelope(payload)
  return callback(body, signingHeaders(body))
}

function eventEnvelope(event_type: string, event: unknown, changes: Record<string, unknown> = {}) {
  return {
    schema: '2.0',
    header: { event_id: 'evt_1', event_type, create_time: '1680000000123', app_id: app.appId, tenant_key: app.tenantKey,
      token: app.verificationToken, ...changes },
    event,
  }
}

const human = { sender_type: 'user', sender_id: { open_id: 'ou_human', union_id: 'on_human' }, tenant_key: app.tenantKey }
const groupText = {
  message_id: 'om_1', chat_id: 'oc_group', chat_type: 'group', message_type: 'text',
  content: JSON.stringify({ text: '@_user_1 请用中文回复 @_user_10 和 @_all' }),
  mentions: [
    { key: '@_user_1', id: { open_id: app.botOpenId }, name: 'Hub' },
    { key: '@_user_10', id: { open_id: 'ou_someone' }, name: 'Hub' },
    { key: '@_all', id: { open_id: 'all' }, name: '所有人' },
  ],
}
const message = () => eventEnvelope('im.message.receive_v1', { sender: human, message: groupText })
const cardAction = {
  operator: { tenant_key: app.tenantKey, open_id: 'ou_human', user_id: 'employee_1' },
  token: 'card-update-token', host: 'im_message', delivery_type: 'url',
  context: { open_chat_id: 'oc_group', open_message_id: 'om_card' },
  action: { tag: 'button', value: { decision: 'confirm', draftId: 'draft_1' } },
}

describe('readFeishuCallback', () => {
  it('verifies the raw request bytes and removes only exact bot mention placeholders', async () => {
    const body = envelope(message())
    const headers = signingHeaders(body)
    await expect(callback(body, headers)).resolves.toEqual({
      event: { id: 'evt_1', chatId: 'oc_group', openId: 'ou_human', kind: 'message', text: '请用中文回复 @_user_10 和 @_all' },
    })
    await expect(callback(Buffer.from(JSON.stringify(JSON.parse(body.toString()))), headers)).resolves.toEqual(ignored)
  })

  it('only echoes URL verification when the correct token is inside the decoded payload', async () => {
    const challenge = { type: 'url_verification', challenge: 'random-challenge', token: app.verificationToken }
    const body = envelope(challenge)
    await expect(callback(body)).resolves.toEqual({ challenge: challenge.challenge })
    await expect(callback(body, signingHeaders(body))).resolves.toEqual({ challenge: challenge.challenge })
    await expect(callback(Buffer.from(JSON.stringify(challenge)))).resolves.toEqual({ challenge: challenge.challenge })
    for (const token of [undefined, '', 'wrong-token', { value: app.verificationToken }]) {
      await expect(callback(envelope({ ...challenge, token }))).resolves.toEqual(ignored)
    }
    await expect(callback(body, {}, { ...app, verificationToken: '' })).resolves.toEqual(ignored)
    await expect(callback(body, {}, { ...app, encryptKey: 'wrong-key' })).resolves.toEqual(ignored)
    await expect(callback(body, { 'x-lark-signature': 'bad' })).resolves.toEqual(ignored)
    await expect(callback(envelope({ ...challenge, challenge: 'a'.repeat(1025) }))).resolves.toEqual(ignored)
    const encrypted = JSON.parse(body.toString()).encrypt
    const mixed = JSON.stringify({ encrypt: encrypted, token: app.verificationToken })
    await expect(callback(Buffer.from(mixed))).resolves.toEqual(ignored)
  })

  it('requires both a fresh signature and an encrypted business event', async () => {
    const body = envelope(message())
    const plain = Buffer.from(JSON.stringify(message()))
    const headers = signingHeaders(body)
    await expect(callback(body)).resolves.toEqual(ignored)
    await expect(callback(plain, signingHeaders(plain))).resolves.toEqual(ignored)
    await expect(callback(body, signingHeaders(body, -301))).resolves.toEqual(ignored)
    await expect(callback(body, signingHeaders(body, 302))).resolves.toEqual(ignored)
    await expect(callback(body, signingHeaders(body, 0, 'wrong-key'))).resolves.toEqual(ignored)
    await expect(callback(body, { ...headers, 'x-lark-request-nonce': ['one', 'two'] })).resolves.toEqual(ignored)
    await expect(callback(body, { ...headers, 'x-lark-request-timestamp': `${headers['x-lark-request-timestamp']}.0` })).resolves.toEqual(ignored)
    await expect(callback(body, signingHeaders(body), { ...app, encryptKey: '' })).resolves.toEqual(ignored)
  })

  it.each([
    { token: 'wrong-token' }, { app_id: 'cli_other' }, { tenant_key: 'other_tenant' },
    { event_id: undefined }, { event_id: 'e'.repeat(257) }, { event_type: 'other.event' },
  ])('ignores unauthenticated or unsupported v2 headers: %j', async changes => {
    await expect(signed(eventEnvelope('im.message.receive_v1', message().event, changes))).resolves.toEqual(ignored)
  })

  it.each([
    { sender: { ...human, sender_type: 'app' }, message: groupText },
    { sender: { ...human, sender_id: { open_id: app.botOpenId } }, message: groupText },
    { sender: { ...human, tenant_key: 'other_tenant' }, message: groupText },
    { sender: human, message: { ...groupText, chat_type: 'p2p' } },
    { sender: human, message: { ...groupText, message_type: 'post' } },
    { sender: human, message: { ...groupText, mentions: groupText.mentions.slice(1) } },
    { sender: human, message: { ...groupText, content: '{"text":"@Hub or @_user_10"}' } },
    { sender: human, message: { ...groupText, content: '{"text":"@_user_1"}' } },
    { sender: human, message: { ...groupText, content: '{broken' } },
    { sender: human, message: { ...groupText, mentions: [...groupText.mentions, { key: '@_user_1', id: { open_id: 'ou_other' } }] } },
  ])('ignores non-human, non-group, or non-bot-addressed messages (%#)', async event => {
    await expect(signed(eventEnvelope('im.message.receive_v1', event))).resolves.toEqual(ignored)
  })

  it('extracts an authenticated card action from context and operator, not from form values', async () => {
    const value = { ...cardAction.action.value, chatId: 'oc_untrusted', openId: 'ou_untrusted' }
    await expect(signed(eventEnvelope('card.action.trigger', { ...cardAction, action: { ...cardAction.action, value } }))).resolves.toEqual({
      event: { kind: 'action', id: 'evt_1', openId: 'ou_human', chatId: 'oc_group', value },
    })
  })

  it.each([
    { operator: { ...cardAction.operator, tenant_key: 'other' } },
    { operator: { open_id: 'ou_human' } },
    { operator: { tenant_key: app.tenantKey, user_id: 'employee_1' } },
    { context: { open_message_id: 'om_card' }, open_chat_id: 'oc_wrong' },
    { action: { value: 'approve' } },
    { action: { value: ['approve'] } },
    { action: { value: { ok: true } } },
    { action: { value: { nested: { value: 'approve' } } } },
    { action: { value: JSON.parse('{"__proto__":"untrusted"}') } },
    { action: { value: { large: '密'.repeat(342) } } },
    { action: { value: Object.fromEntries(Array.from({ length: 33 }, (_, index) => [String(index), 'value'])) } },
  ])('ignores card actions without trusted context or a bounded string map (%#)', async changes => {
    await expect(signed(eventEnvelope('card.action.trigger', { ...cardAction, ...changes }))).resolves.toEqual(ignored)
  })

  it('ignores oversized, malformed, and unsupported payloads', async () => {
    const invalidUtf8 = Buffer.concat([Buffer.from('{"data":"'), Buffer.from([0xff]), Buffer.from('"}')])
    const bodies = [Buffer.alloc(256 * 1024 + 1), Buffer.from(']'), Buffer.from('{"encrypt":"AAAA"}'),
      invalidUtf8, envelope(message(), 'wrong-key')]
    for (const body of bodies) await expect(callback(body, signingHeaders(body))).resolves.toEqual(ignored)
    await expect(signed({ ...message(), schema: '1.0' })).resolves.toEqual(ignored)
    const content = JSON.stringify({ text: '@_user_1 ' + '密'.repeat(6000) })
    await expect(signed(eventEnvelope('im.message.receive_v1', { sender: human, message: { ...groupText, content } }))).resolves.toEqual(ignored)
  })
})
