import { join } from 'node:path'
import { openProject, type ProjectStores } from '@taktflow/core'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { FeishuBindings } from './feishu-bindings.js'
import { createFeishuSender, readFeishuCallback, type FeishuApp, type FeishuEvent } from './feishu-wire.js'
import { handleFeishuEvent } from './feishu-actions.js'
import { FeishuQueue, type FeishuEnvelope } from './feishu-queue.js'
import { scanFeishuSpace } from './feishu-notifications.js'
import { HttpError, json } from './http.js'
import type { M3Callbacks } from './m3-routes.js'
import { spaceId } from './space.js'

export const feishuCallbackPath = '/api/feishu/events'

export function feishuAppFromEnv(env: NodeJS.ProcessEnv): FeishuApp | undefined {
  if (!env.TAKT_FEISHU_APP_ID) return
  const read = (name: string) => {
    const value = env['TAKT_FEISHU_' + name]?.trim()
    if (!value) throw new Error(`启用飞书机器人需要 TAKT_FEISHU_${name}`)
    return value
  }
  const url = new URL(read('PUBLIC_URL'))
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('TAKT_FEISHU_PUBLIC_URL 应为团队 Web 入口的 HTTPS 源地址')
  }
  return { appId: read('APP_ID'), appSecret: read('APP_SECRET'), encryptKey: read('ENCRYPT_KEY'),
    verificationToken: read('VERIFICATION_TOKEN'), tenantKey: read('TENANT_KEY'), botOpenId: read('BOT_OPEN_ID'), publicBaseUrl: url.origin }
}

export function createFeishuRuntime(root: string, app: FeishuApp | undefined, spaces: () => ProjectStores[],
  options: M3Callbacks, fetcher?: typeof fetch) {
  const bindings = new FeishuBindings(root)
  const setup = { bindings, configured: !!app }
  if (!app) return { ...setup, callback: async () => { throw new HttpError(404, '飞书机器人未启用') },
    scan: async () => {}, close: async () => {} }

  const send = createFeishuSender(app, fetcher)
  const resolve = async (entry: FeishuEnvelope) => {
    const binding = await bindings.get(entry.spaceId)
    if (!binding || binding.revision !== entry.revision || binding.chatId !== entry.chatId) return
    const space = spaces().find(item => spaceId(item) === entry.spaceId)
    if (!space) return
    const stores = await openProject(space.projectDir)
    if (spaceId(stores) !== entry.spaceId) return
    if (entry.event) {
      const { openId } = entry.event
      if (!entry.memberId || !binding.members.some(m => m.openId === openId && m.memberId === entry.memberId)) return
      if (!stores.config.members?.some(m => m.id === entry.memberId && m.role !== 'viewer')) return
    }
    return stores
  }
  const queue = new FeishuQueue(join(root, 'queue'), {
    prepare: async entry => {
      const stores = await resolve(entry)
      if (!stores || !entry.event || !entry.memberId) return
      return handleFeishuEvent(stores, entry.memberId, entry.event, { bindingRevision: entry.revision, publicBaseUrl: app.publicBaseUrl, options,
        assertCurrentBinding: async () => { if (!await resolve(entry)) throw new HttpError(403, '当前飞书成员映射已失效') },
      })
    },
    deliver: async (entry, message, uuid) => {
      if (await resolve(entry)) await send(entry.chatId, message, uuid)
    },
  })
  const receive = async (event: FeishuEvent) => {
    const target = await bindings.find(event.chatId)
    const member = target?.binding.members.find(item => item.openId === event.openId)
    if (!target || !member) return false
    const entry = { key: `event:${app.appId}:${event.id}`, chatId: event.chatId, spaceId: target.spaceId,
      memberId: member.memberId, revision: target.binding.revision, event }
    if (!await resolve(entry)) return false
    await queue.put(entry)
    queue.kick()
    return true
  }
  return { ...setup,
    callback: async (request: IncomingMessage, response: ServerResponse) => {
      if (request.method !== 'POST') throw new HttpError(405, '飞书回调使用 POST')
      const payload = await readFeishuCallback(request, app)
      if ('challenge' in payload) return json(response, { challenge: payload.challenge })
      if ('event' in payload) {
        const accepted = await receive(payload.event)
        if (payload.event.kind === 'action') {
          return json(response, { toast: accepted ? { type: 'info', content: '已收到，处理结果会发到本群' }
            : { type: 'warning', content: '请联系空间负责人检查群绑定和成员权限' } })
        }
      }
      json(response, {})
    },
    scan: async () => {
      queue.kick()
      const failures = []
      for (const stores of spaces()) {
        try {
          const binding = await bindings.get(spaceId(stores))
          if (binding) await scanFeishuSpace(stores, binding, app.publicBaseUrl, queue)
        } catch (error) { failures.push(error) }
      }
      queue.kick()
      if (failures.length) throw new AggregateError(failures, '部分空间飞书同步失败')
    },
    close: () => queue.close(),
  }
}
