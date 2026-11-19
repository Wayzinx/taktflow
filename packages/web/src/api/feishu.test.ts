import { afterEach, describe, expect, it, vi } from 'vitest'
import { setActingUser } from '../lib/acting-user.js'
import { createHttpSource } from './client.js'
import { readOnlyDemo } from './demo.js'
import type { FeishuBindingStatus } from './feishu.js'
import { createMockSource } from './mock-source.js'

const bound: FeishuBindingStatus = {
  configured: true,
  binding: { chatId: 'oc_release', members: [{ openId: 'ou_qa', memberId: 'qa' }], revision: 'first' },
}
const unbound = { configured: true, binding: null }

afterEach(() => vi.unstubAllGlobals())

describe('飞书群绑定接口', () => {
  it('GET 使用当前空间身份，绑定数据源固定使用对应空间的 URL 和身份', async () => {
    const route = { pathname: '/s/feishu-alpha/settings' }
    vi.stubGlobal('location', route)
    setActingUser('alice')
    route.pathname = '/s/feishu-beta%20lab/settings'
    setActingUser('bob')
    const fetch = vi.fn(async () => Response.json(bound))
    vi.stubGlobal('fetch', fetch)
    const source = createHttpSource()

    await expect(source.feishuBinding()).resolves.toEqual(bound)
    await expect(source.forSpace('feishu-alpha').feishuBinding()).resolves.toEqual(bound)
    expect(fetch).toHaveBeenNthCalledWith(1, '/api/s/feishu-beta%20lab/space/feishu', expect.objectContaining({ method: 'GET', headers: { 'x-takt-user': 'bob' } }))
    expect(fetch).toHaveBeenNthCalledWith(2, '/api/s/feishu-alpha/space/feishu', expect.objectContaining({ method: 'GET', headers: { 'x-takt-user': 'alice' } }))
  })

  it('PUT 只发送绑定字段，不发送额外数据；解绑只发送群和基线', async () => {
    vi.stubGlobal('location', { pathname: '/s/feishu-write/settings' })
    setActingUser('owner-id')
    const fetch = vi.fn(async () => Response.json(bound)).mockResolvedValueOnce(Response.json(bound)).mockResolvedValueOnce(Response.json(unbound))
    vi.stubGlobal('fetch', fetch)
    const source = createHttpSource().forSpace('feishu-write')
    const member = { openId: 'ou_qa', memberId: 'qa', unrelated: 'not part of the mapping' }
    const update = { chatId: 'oc_release', baseRevision: null, members: [member], extra: 'not part of the update' }

    await expect(source.setFeishuBinding(update)).resolves.toEqual(bound)
    await expect(source.setFeishuBinding({ chatId: null, baseRevision: 'first' })).resolves.toEqual(unbound)
    const request = { method: 'PUT', headers: { 'x-takt-user': 'owner-id', 'content-type': 'application/json' } }
    expect(fetch).toHaveBeenNthCalledWith(1, '/api/s/feishu-write/space/feishu', {
      ...request, body: JSON.stringify({ chatId: 'oc_release', members: [{ openId: 'ou_qa', memberId: 'qa' }], baseRevision: null }), signal: undefined,
    })
    expect(fetch).toHaveBeenNthCalledWith(2, '/api/s/feishu-write/space/feishu', {
      ...request, body: JSON.stringify({ chatId: null, baseRevision: 'first' }), signal: undefined,
    })
  })

  it('保留 409 和 403，飞书冲突不当成流水线的合并冲突', async () => {
    vi.stubGlobal('location', { pathname: '/settings' })
    const fetch = vi.fn().mockResolvedValueOnce(Response.json({ error: 'conflict' }, { status: 409 }))
      .mockResolvedValueOnce(Response.json({ error: '仅空间 owner 可以访问' }, { status: 403 }))
    vi.stubGlobal('fetch', fetch)
    const source = createHttpSource()
    await expect(source.setFeishuBinding({ chatId: null, baseRevision: 'old' })).rejects.toMatchObject({ status: 409 })
    await expect(source.feishuBinding()).rejects.toMatchObject({ status: 403 })
    expect(fetch).toHaveBeenCalledWith('/api/space/feishu', expect.objectContaining({ method: 'GET' }))
  })

  it('演示数据按空间提供，不联网、不允许写入', async () => {
    vi.stubGlobal('location', { pathname: '/s/hello-delivery/settings' })
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    const source = readOnlyDemo(createMockSource())
    await expect(source.feishuBinding()).resolves.toMatchObject({ configured: true, binding: { members: [{ memberId: 'wayne' }, { memberId: 'lin' }] } })
    await expect(source.forSpace('growth-lab').feishuBinding()).resolves.toEqual(unbound)
    await expect(source.setFeishuBinding({ chatId: null, baseRevision: 'demo-1' })).rejects.toMatchObject({ status: 405 })
    expect(fetch).not.toHaveBeenCalled()
  })
})
