import { afterEach, describe, expect, it, vi } from 'vitest'
import { createFeishuSender, type FeishuApp } from './feishu-wire.js'

const app: FeishuApp = {
  appId: 'cli_demo', appSecret: 'secret-app-credential', verificationToken: 'verify-this', encryptKey: 'encrypt-key',
  botOpenId: 'ou_bot', tenantKey: 'tenant_demo', publicBaseUrl: 'https://not-the-feishu-api.example.test',
}
const authUrl = 'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal'
const sendUrl = 'https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id'
const text = { type: 'text', content: { text: '你好' } } as const
const card = { type: 'interactive', content: { schema: '2.0', body: { elements: [] } } } as const
const token = 'secret-tenant-token'

function tokenResponse(value = token, expire = 7200) {
  return Response.json({ code: 0, msg: 'ok', tenant_access_token: value, expire })
}

describe('createFeishuSender', () => {
  afterEach(() => vi.useRealTimers())

  it('posts canonical auth, text and interactive payloads without following redirects', async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(tokenResponse())
      .mockImplementation(async () => Response.json({ code: 0 }))
    const send = createFeishuSender(app, fetcher)
    const dedupId = 'run/output/'.repeat(100)
    await send('oc_group', text, dedupId)
    await send('oc_group', text, dedupId)
    await send('oc_group', card, 'card-1')
    await send('oc_other', text, dedupId)
    fetcher.mockResolvedValueOnce(tokenResponse())
    await createFeishuSender(app, fetcher)('oc_group', text, dedupId)

    const [auth, first, repeated, interactive, other, secondAuth, restarted] = fetcher.mock.calls
    expect(auth?.[0]).toBe(authUrl)
    expect(secondAuth?.[0]).toBe(authUrl)
    expect(auth?.[1]).toMatchObject({ method: 'POST', redirect: 'error' })
    expect(JSON.parse(String(auth?.[1]?.body))).toEqual({ app_id: app.appId, app_secret: app.appSecret })
    expect(new Headers(auth?.[1]?.headers).get('authorization')).toBeNull()
    for (const call of [first, repeated, interactive, other, restarted]) {
      expect(call?.[0]).toBe(sendUrl)
      expect(call?.[1]).toMatchObject({ method: 'POST', redirect: 'error', signal: expect.any(AbortSignal) })
      expect(new Headers(call?.[1]?.headers).get('authorization')).toBe(`Bearer ${token}`)
    }
    const content = (call: typeof first) => JSON.parse(String(call?.[1]?.body))
    const uuid: string = content(first).uuid
    expect(uuid).toMatch(/^[a-f0-9]{8}-[a-f0-9]{4}-8[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/)
    expect(content(first)).toEqual({ receive_id: 'oc_group', msg_type: 'text', content: JSON.stringify(text.content), uuid })
    expect(content(repeated).uuid).toBe(uuid)
    expect(content(restarted).uuid).toBe(uuid)
    expect(content(other).uuid).not.toBe(uuid)
    expect(content(interactive)).toMatchObject({ receive_id: 'oc_group', msg_type: 'interactive', content: JSON.stringify(card.content) })
    expect(content(interactive).uuid).not.toBe(uuid)
  })

  it('coalesces concurrent token requests and refreshes an expiring token', async () => {
    vi.useFakeTimers()
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url) => {
      return url === authUrl ? tokenResponse(token, 10) : Response.json({ code: 0 })
    })
    const send = createFeishuSender(app, fetcher)
    await Promise.all([send('oc_group', text, 'one'), send('oc_group', text, 'two')])
    expect(fetcher.mock.calls.filter(([url]) => url === authUrl)).toHaveLength(1)
    vi.advanceTimersByTime(10_000)
    fetcher.mockResolvedValueOnce(tokenResponse('new-token'))
    await send('oc_group', text, 'three')
    expect(fetcher.mock.calls.filter(([url]) => url === authUrl)).toHaveLength(2)
    expect(new Headers(fetcher.mock.lastCall?.[1]?.headers).get('authorization')).toBe('Bearer new-token')
  })

  it('does not cache failed auth or leak upstream error details', async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ code: 1, msg: app.appSecret }))
      .mockResolvedValueOnce(tokenResponse('injected\r\nHeader: fail'))
      .mockResolvedValueOnce(tokenResponse())
      .mockRejectedValueOnce(new Error(`bad request with ${token}`))
      .mockResolvedValueOnce(Response.json({ code: 0 }))
    const send = createFeishuSender(app, fetcher)
    await expect(send('oc_group', text, 'one')).rejects.toEqual(new Error('飞书获取租户令牌请求失败'))
    await expect(send('oc_group', text, 'one')).rejects.toEqual(new Error('飞书租户令牌响应格式不正确'))
    await expect(send('oc_group', text, 'one')).rejects.toEqual(new Error('飞书发消息请求失败'))
    await expect(send('oc_group', text, 'one')).resolves.toBeUndefined()
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual([authUrl, authUrl, authUrl, sendUrl, sendUrl])
  })

  it.each([
    () => Response.redirect('https://never-follow.example.test'),
    () => Response.json({ code: 0 }, { status: 403 }),
    () => Response.json({ code: 230001, msg: token }),
    () => Response.json({ code: '0' }),
    () => Response.json({}),
    () => new Response('<html>bad JSON</html>'),
  ])('rejects redirects, HTTP failures, and invalid Feishu replies (%#)', async reply => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(tokenResponse()).mockResolvedValueOnce(reply())
    const send = createFeishuSender(app, fetcher)
    await expect(send('oc_group', text, 'test')).rejects.toEqual(new Error('飞书发消息请求失败'))
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it.each(['fetch', 'response body'])('aborts a timed-out %s', async phase => {
    vi.useFakeTimers()
    const response = tokenResponse()
    vi.spyOn(response, 'json').mockReturnValue(new Promise(() => undefined))
    const fetcher = vi.fn<typeof fetch>().mockImplementation(() => phase === 'fetch'
      ? new Promise(() => undefined) : Promise.resolve(response))
    const result = createFeishuSender(app, fetcher)('oc_group', text, 'test')
    const asserted = expect(result).rejects.toEqual(new Error('飞书获取租户令牌请求失败'))
    await vi.advanceTimersByTimeAsync(5_000)
    await asserted
    expect(fetcher.mock.lastCall?.[1]?.signal?.aborted).toBe(true)
    expect(fetcher).toHaveBeenCalledTimes(1)
  })
})
