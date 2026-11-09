import { createHmac } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import { sendToChannel } from './channel-delivery.js'
import type { ChannelConfig } from '@taktflow/core'
const message = { automation: { id: 'daily', title: '日报' }, text: '进展', event: { type: 'run.failed' as const, runId: 'r' }, links: ['http://app.invalid/run/r'] }
afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers() })
it.each(['feishu', 'slack', 'webhook'] as const)('%s 请求体与签名不发真实网络', async kind => {
  vi.stubEnv('AUTOMATION_URL', 'https://bot.invalid/hook'); vi.stubEnv('AUTOMATION_SECRET', 'fixture-signing')
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ code: 0 })))
  const channel: ChannelConfig = { id: 'chat', kind, urlEnv: 'AUTOMATION_URL', secretEnv: 'AUTOMATION_SECRET' }
  const result = await sendToChannel(channel, message, fetcher, { now: () => new Date(1700000000000) })
  expect(result).toMatchObject({ ok: true, channel: 'chat', status: 200 })
  const init = fetcher.mock.calls[0]![1]!, body = JSON.parse(init.body as string)
  if (kind === 'feishu') expect(body).toEqual({ msg_type: 'text', content: { text: '进展' }, timestamp: '1700000000', sign: createHmac('sha256', '1700000000\nfixture-signing').update('').digest('base64') })
  if (kind === 'slack') expect(body).toEqual({ text: '进展' })
  if (kind === 'webhook') {
    expect(body).toEqual(message)
    expect(init.headers).toMatchObject({ 'X-Takt-Signature': `sha256=${createHmac('sha256', 'fixture-signing').update(init.body as string).digest('hex')}` })
  }
})
it('失败仅重试一次，HTTP 错误与飞书业务错误脱敏', async () => {
  vi.stubEnv('AUTOMATION_URL', 'https://bot.invalid/private'); vi.stubEnv('AUTOMATION_SECRET', 'sensitive-fixture')
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response(JSON.stringify({ code: 9, msg: 'https://bot.invalid/private sensitive-fixture' })))
  const wait = vi.fn(async () => {})
  const result = await sendToChannel({ id: 'chat', kind: 'feishu', urlEnv: 'AUTOMATION_URL', secretEnv: 'AUTOMATION_SECRET' }, message, fetcher, { wait })
  expect(result.ok).toBe(false); expect(fetcher).toHaveBeenCalledTimes(2); expect(wait).toHaveBeenCalledWith(2000)
  expect(result.error).not.toContain('sensitive-fixture'); expect(result.error).not.toContain('bot.invalid'); expect(result.error).toContain('飞书返回失败')
})
it('10 秒超时、间隔 2 秒、第二次成功；缺失密钥不发请求', async () => {
  vi.useFakeTimers(); vi.stubEnv('AUTOMATION_URL', 'https://bot.invalid/hook')
  const fetcher = vi.fn<typeof fetch>().mockImplementationOnce(() => new Promise(() => {})).mockResolvedValueOnce(new Response('ok'))
  const promise = sendToChannel({ id: 'chat', kind: 'slack', urlEnv: 'AUTOMATION_URL' }, message, fetcher)
  await vi.advanceTimersByTimeAsync(10_000); expect(fetcher).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(2000); expect((await promise).ok).toBe(true)
  expect(fetcher.mock.calls[0]![1]!.signal!.aborted).toBe(true)
  vi.stubEnv('AUTOMATION_URL', '')
  expect((await sendToChannel({ id: 'chat', kind: 'slack', urlEnv: 'AUTOMATION_URL' }, message, fetcher)).ok).toBe(false)
  expect(fetcher).toHaveBeenCalledTimes(2)
})
