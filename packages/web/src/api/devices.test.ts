import { afterEach, describe, expect, it, vi } from 'vitest'
import { setActingUser } from '../lib/acting-user.js'
import { createHttpSource } from './client.js'
import { readOnlyDemo } from './demo.js'
import type { DeviceLink, DeviceLinkRequest, SpaceDevices } from './devices.js'
import { createMockSource } from './mock-source.js'

afterEach(() => vi.unstubAllGlobals())

describe('空间设备接口', () => {
  it('读取当前空间，并用绑定空间的身份生成配对码及撤销设备', async () => {
    const route = { pathname: '/s/alpha/devices' }
    vi.stubGlobal('location', route)
    setActingUser('alice')
    route.pathname = '/s/beta%20lab/devices'
    setActingUser('bob')
    const list: SpaceDevices = { spaceId: 'beta lab', devices: [{ nodeId: 'runner', harness: 'codex', source: 'env', status: 'online', jobId: 'job-1' }] }
    const payload: DeviceLinkRequest = { nodeId: 'mac-mini', harness: 'codex' }
    const link: DeviceLink = { ...payload, expiresAt: '2026-11-19T12:00:00Z', code: 'fixture-only' }
    const fetch = vi.fn()
      .mockResolvedValueOnce(Response.json(list))
      .mockResolvedValueOnce(Response.json(link))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
    vi.stubGlobal('fetch', fetch)
    const source = createHttpSource()
    const signal = new AbortController().signal

    await expect(source.devices(signal)).resolves.toEqual(list)
    await expect(source.forSpace('alpha').createDeviceLink(payload, signal)).resolves.toEqual(link)
    await expect(source.forSpace('alpha').revokeDevice('runner/old', signal)).resolves.toBeUndefined()
    expect(fetch).toHaveBeenNthCalledWith(1, '/api/s/beta%20lab/space/devices', { method: 'GET', headers: { 'x-takt-user': 'bob' }, body: undefined, signal })
    expect(fetch).toHaveBeenNthCalledWith(2, '/api/s/alpha/space/devices/link', {
      method: 'POST', headers: { 'x-takt-user': 'alice', 'content-type': 'application/json' }, body: JSON.stringify(payload), signal, cache: 'no-store',
    })
    expect(fetch).toHaveBeenNthCalledWith(3, '/api/s/alpha/space/devices/runner%2Fold', {
      method: 'DELETE', headers: { 'x-takt-user': 'alice', 'content-type': 'application/json' }, body: '{}', signal,
    })
  })

  it('默认空间不加前缀并保留 Hub 的权限错误', async () => {
    vi.stubGlobal('location', { pathname: '/devices' })
    const fetch = vi.fn(async () => Response.json({ error: '需要 Owner 身份' }, { status: 403 }))
    vi.stubGlobal('fetch', fetch)
    await expect(createHttpSource().devices()).rejects.toMatchObject({ status: 403 })
    expect(fetch).toHaveBeenCalledWith('/api/space/devices', expect.objectContaining({ method: 'GET' }))
  })

  it('演示设备按空间读取，写请求均被拒绝', async () => {
    vi.stubGlobal('location', { pathname: '/s/hello-delivery/devices' })
    const source = readOnlyDemo(createMockSource())
    const list = await source.devices()
    expect(list.spaceId).toBe('hello-delivery')
    expect(list.devices.map(({ source, status }) => [source, status])).toEqual([['link', 'online'], ['env', 'offline']])
    const empty = source.forSpace('growth-lab')
    await expect(empty.devices()).resolves.toEqual({ spaceId: 'growth-lab', devices: [] })
    await expect(source.createDeviceLink({ nodeId: 'mac-mini', harness: 'codex' })).rejects.toMatchObject({ status: 405 })
    await expect(empty.revokeDevice('mac-mini')).rejects.toMatchObject({ status: 405 })
  })
})
