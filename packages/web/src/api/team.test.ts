import { afterEach, describe, expect, it, vi } from 'vitest'
import { setActingUser } from '../lib/acting-user'
import { createHttpSource } from './client'
import { readOnlyDemo } from './demo'
import { createMockSource } from './mock-source'
import type { TeamPost, TeamSnapshot } from './team'

const EMPTY: TeamSnapshot = { messages: [], nodes: [], jobs: [] }
const payload: TeamPost = { requestId: 'request-1', mode: 'chat', text: '看下当前进度' }

afterEach(() => vi.unstubAllGlobals())

describe('团队接口', () => {
  it('读取 URL 所在空间，绑定空间的发送使用绑定空间的身份', async () => {
    const route = { pathname: '/s/alpha/team' }
    vi.stubGlobal('location', route)
    setActingUser('alice')
    route.pathname = '/s/beta%20lab/team'
    setActingUser('bob')
    const fetch = vi.fn(async (_url: string, _init: RequestInit) => Response.json(EMPTY))
    vi.stubGlobal('fetch', fetch)
    const source = createHttpSource()
    const signal = new AbortController().signal

    await expect(source.team(signal)).resolves.toEqual(EMPTY)
    expect(fetch).toHaveBeenNthCalledWith(1, '/api/s/beta%20lab/space/team', expect.objectContaining({ method: 'GET', headers: { 'x-takt-user': 'bob' }, signal }))
    await expect(source.forSpace('alpha').postTeamMessage(payload, signal)).resolves.toEqual(EMPTY)
    expect(fetch).toHaveBeenNthCalledWith(2, '/api/s/alpha/space/team/messages', {
      method: 'POST', headers: { 'x-takt-user': 'alice', 'content-type': 'application/json' }, body: JSON.stringify(payload), signal,
    })
  })

  it('身份改变时不复用同一空间的旧 me 请求', async () => {
    vi.stubGlobal('location', { pathname: '/s/identity-test/team' })
    const fetch = vi.fn(async (_url: string, init: RequestInit) => {
      const id = new Headers(init.headers).get('x-takt-user')
      return Response.json({ id, name: id })
    })
    vi.stubGlobal('fetch', fetch)
    const source = createHttpSource()
    setActingUser('first')
    const first = source.me()
    setActingUser('second')
    const second = source.me()
    await expect(first).resolves.toMatchObject({ id: 'first' })
    await expect(second).resolves.toMatchObject({ id: 'second' })
  })

  it('默认空间路径不加前缀，保留服务端权限错误', async () => {
    vi.stubGlobal('location', { pathname: '/team' })
    const fetch = vi.fn(async () => Response.json({ error: '当前角色只读' }, { status: 403 }))
    vi.stubGlobal('fetch', fetch)
    await expect(createHttpSource().postTeamMessage(payload)).rejects.toMatchObject({ status: 403, message: '当前角色只读' })
    expect(fetch).toHaveBeenCalledWith('/api/space/team/messages', expect.objectContaining({ method: 'POST' }))
  })

  it('演示对话按空间读取，包含关联记录和任务结果但不能写入', async () => {
    vi.stubGlobal('location', { pathname: '/s/hello-delivery/team' })
    const source = readOnlyDemo(createMockSource())
    const team = await source.team()
    expect(team.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ requirementId: 'REQ-001', runId: 'run-20261104-0001' }),
      expect.objectContaining({ jobId: team.jobs[0]?.id }),
    ]))
    expect(team.jobs[0]).toMatchObject({ status: 'succeeded', result: expect.any(String) })
    expect(team.nodes.map((node) => node.online)).toEqual([true, false])
    await expect(source.forSpace('growth-lab').team()).resolves.toEqual(EMPTY)
    await expect(source.postTeamMessage(payload)).rejects.toMatchObject({ status: 405 })
  })
})
