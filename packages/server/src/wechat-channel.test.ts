import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { initSpace } from './space-admin.js'
import { teamRoomStore } from './team-room-store.js'
import { listenWeChat } from './wechat-channel.js'
import { wechatClient } from './wechat-wire.js'

const owner = 'fixture@im.wechat'
const account = { userId: owner, token: 'fixture-token' }
const msg = { message_id: '888', from_user_id: owner, context_token: 'fixture-context', message_type: 1,
  item_list: [{ type: 1, text_item: { text: '团队还有多少需求？' } }] }
const roots: string[] = []
afterEach(async () => { for (const dir of roots.splice(0)) await rm(dir, { recursive: true, force: true }) })
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'takt-wechat-'))
  roots.push(root)
  const project = join(root, 'alpha')
  const credential = join(root, 'bot.json')
  const stores = await initSpace(project, 'blank')
  const config = join(project, 'takt.config.json')
  const changeRole = async (role: string) => {
    const data = JSON.parse(await readFile(config, 'utf8'))
    await writeFile(config, JSON.stringify({ ...data, members: [{ id: 'alice', name: 'Alice', role }, { id: 'bob', name: 'Bob', role: 'member' }] }))
  }
  await changeRole('member')
  await writeFile(credential, JSON.stringify(account), { mode: 0o600 })
  return { project, credential, stores, changeRole }
}
const ok = (json: unknown) => Response.json(json)

it('个人微信使用腾讯扫码身份和单聊上下文；大整数消息 ID 无精度损失', async () => {
  const input = JSON.stringify({ get_updates_buf: 'next', msgs: [msg, { ...msg, group_id: 'group' },
    { ...msg, message_type: 2 }, { ...msg, from_user_id: 'stranger' }, { ...msg, context_token: '' }] })
    .replace('"888"', '18446744073709551615')
  const fetcher = vi.fn(async () => new Response(input))
  const client = wechatClient(account, fetcher, new AbortController().signal)
  const batch = await client.poll('prev')
  expect(batch).toEqual({ cursor: 'next', turns: [{ id: '18446744073709551615', context: msg.context_token, text: msg.item_list[0]!.text_item.text }] })
  expect(fetcher).toHaveBeenCalledWith(new URL('https://ilinkai.weixin.qq.com/ilink/bot/getupdates'),
    expect.objectContaining({ redirect: 'error', method: 'POST', headers: expect.objectContaining({ Authorization: 'Bearer fixture-token' }),
      body: expect.stringContaining('"get_updates_buf":"prev"') }))
  expect(() => wechatClient({ ...account, baseUrl: 'https://example.org' }, fetcher, new AbortController().signal)).toThrow('腾讯 HTTPS')
})

it('首轮写入真实共享会话，回信失败后恢复同一消息并使用原上下文回微信', async () => {
  const { project, credential, stores } = await fixture()
  const room = teamRoomStore(stores.taktDir)
  const first = vi.fn<typeof fetch>(async (url) =>
    String(url).endsWith('/getupdates') ? ok({ ret: 0, msgs: [msg], get_updates_buf: 'new' }) : ok({ ret: -14 }))
  await expect(listenWeChat(project, 'alice', credential, new AbortController().signal, () => {}, first)).rejects.toThrow('-14')
  const history = await room.messages()
  expect(history.map(m => [m.source, m.author])).toEqual([['wechat', 'alice'], ['wechat', 'steward']])
  expect(history[0]?.text).toBe(msg.item_list[0]!.text_item.text)
  expect(history[1]?.text).toBeTruthy()

  const ctl = new AbortController()
  const resumed = vi.fn<typeof fetch>(async (url, req) => {
    if (String(url).endsWith('/sendmessage')) {
      const { msg: reply } = JSON.parse(String(req?.body))
      expect(reply).toMatchObject({ message_type: 2, message_state: 2, to_user_id: owner, context_token: msg.context_token,
        item_list: [{ type: 1, text_item: { text: history[1]!.text } }] })
      expect(reply.client_id).toBe(JSON.parse(String(first.mock.calls[1]?.[1]?.body)).msg.client_id)
      return ok({ ret: 0 })
    }
    expect(JSON.parse(String(req?.body)).get_updates_buf).toBe('new')
    if (resumed.mock.calls.length === 2) return ok({ ret: 0, msgs: [msg], get_updates_buf: 'new' })
    ctl.abort()
    return ok({ ret: 0 })
  })
  await listenWeChat(project, 'alice', credential, ctl.signal, () => {}, resumed)
  expect(resumed.mock.calls.map(([url]) => new URL(String(url)).pathname.split('/').at(-1))).toEqual(['sendmessage', 'getupdates', 'getupdates'])
  expect(await room.messages()).toEqual(history)
  const statePath = credential + '.taktflow.json'
  expect((await stat(statePath)).mode & 0o777).toBe(0o600)
  const saved = await readFile(statePath, 'utf8')
  expect(saved).not.toContain(account.token)
  expect(saved).not.toContain(msg.context_token)
  const never = vi.fn<typeof fetch>()
  await expect(listenWeChat(project, 'bob', credential, new AbortController().signal, () => {}, never)).rejects.toThrow('其他空间或成员')
  expect(never).not.toHaveBeenCalled()
})

it('入站前撤销成员权限时拒绝发言，不接受账号索引文件或其他用户可读的凭据', async () => {
  const { project, credential, stores, changeRole } = await fixture()
  const ctl = new AbortController()
  const receive = vi.fn<typeof fetch>(async () => {
    await changeRole('viewer')
    return ok({ get_updates_buf: 'new', msgs: [msg] })
  })
  await expect(listenWeChat(project, 'alice', credential, ctl.signal, () => {}, receive)).rejects.toThrow('发言权限')
  expect(receive).toHaveBeenCalledTimes(1)
  expect(await teamRoomStore(stores.taktDir).messages()).toEqual([])
  const never = vi.fn<typeof fetch>()
  await expect(listenWeChat(project, 'alice', join(project, '..', 'accounts.json'), ctl.signal, () => {}, never)).rejects.toThrow('具体微信账号文件')
  await chmod(credential, 0o644)
  await expect(listenWeChat(project, 'alice', credential, ctl.signal, () => {}, never)).rejects.toThrow('chmod 600')
  expect(never).not.toHaveBeenCalled()
})
