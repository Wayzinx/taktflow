import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { createFeishuRuntime } from './feishu-runtime.js'
import { initSpace } from './space-admin.js'
import { teamRoomStore } from './team-room-store.js'

it('仅向绑定群同步新增 Web 发言，飞书发言不回声，重启不重发，解绑停止转发', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'takt-feishu-notice-'))
  const messages: Array<{ receive_id: string; content: string }> = []
  const fetcher: typeof fetch = async (url, init) => {
    if (String(url).includes('/tenant_access_token/')) {
      return Response.json({ code: 0, tenant_access_token: 'test-token', expire: 3600 })
    }
    messages.push(JSON.parse(String(init?.body)))
    return Response.json({ code: 0 })
  }
  const stores = await initSpace(join(dir, 'alpha'), 'blank')
  const app = { appId: 'test', appSecret: 'secret', verificationToken: 'verify', encryptKey: 'encrypt',
    tenantKey: 'tenant', botOpenId: 'ou_test', publicBaseUrl: 'https://example.com' }
  const start = () => createFeishuRuntime(join(dir, 'hub'), app, () => [stores], {}, fetcher)
  let runtime = start()
  const room = teamRoomStore(stores.taktDir)
  const say = (text: string, source?: 'feishu') => room.submit('member', text, { text }, text,
    async () => ({ text: text + '的回复' }), { source })
  try {
    await say('绑定前')
    const binding = await runtime.bindings.update('alpha', { chatId: 'oc_one', members: [] }, null)
    await say('来自群里', 'feishu')
    await say('来自网页')
    await runtime.scan()
    await vi.waitFor(() => expect(messages).toHaveLength(2))
    expect(messages.map(m => JSON.parse(m.content).text)).toEqual(['【member · 空间对话】\n来自网页', '【管家 · 空间对话】\n来自网页的回复'])
    expect(messages.every(m => m.receive_id === 'oc_one')).toBe(true)
    await runtime.close()
    runtime = start()
    await runtime.scan()
    await runtime.bindings.update('alpha', null, binding!.revision)
    await say('解绑后')
    await runtime.scan()
    await runtime.close()
    expect(messages).toHaveLength(2)
  } finally {
    await runtime.close()
    await rm(dir, { recursive: true, force: true })
  }
})
