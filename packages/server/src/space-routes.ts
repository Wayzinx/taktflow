import { join } from 'node:path'
import { access } from 'node:fs/promises'
import { listReviews, type RoomMember, type RoomMessage } from '@taktflow/core'
import { authorize, actor, body, jsonBody, HttpError, integer, text } from './http.js'
import { atomicWrite, auditSpace, changeConfig, members, repoBinding, repoManager, spaceDetail, spaceFile } from './space.js'
import { requirement } from './read-model.js'
import { stream } from './stream.js'
import type { M3Callbacks } from './m3-routes.js'
import { STREAMING, type Handler } from './routes.js'

export type LeadMention = (requirementId: string, message: RoomMessage) => void | Promise<void>
export function spaceRoutes(add: (method: string, path: string, handler: Handler) => void, connections: Set<() => void>, onLeadMention?: LeadMention, options: M3Callbacks = {}) {
  add('GET', '/api/space', ({ stores }) => spaceDetail(stores))
  add('PUT', '/api/space/members', async ({ stores, request }) => {
    authorize(request, stores, 'owner')
    const input = await jsonBody(request)
    const record = input as Record<string, unknown> | null
    const value = members(Array.isArray(input) ? input : record?.members)
    const reason = Array.isArray(input) ? request.headers['x-takt-reason'] : record?.reason
    await changeConfig(stores, actor(request, stores), text(reason, 'reason'), '更新空间成员', (config) => { config.members = value })
    return spaceDetail(stores)
  })
  add('POST', '/api/space/repos', async ({ stores, request }) => {
    authorize(request, stores, 'maintainer')
    const input = await body(request)
    const repo = repoBinding(input)
    await changeConfig(stores, actor(request, stores), text(input.reason, 'reason'), `绑定仓库 ${repo.id}`, (config) => {
      if (config.repos?.some((item) => item.id === repo.id)) throw new HttpError(409, '仓库已绑定')
      config.repos = [...config.repos ?? [], repo]
    })
    return spaceDetail(stores)
  })
  add('PATCH', '/api/space/repos/:repoId', async ({ stores, request, params }) => {
    authorize(request, stores, 'maintainer')
    const input = await body(request)
    const reason = text(input.reason, 'reason')
    await changeConfig(stores, actor(request, stores), reason, `更新仓库 ${params.repoId}`, (config) => {
      const index = config.repos?.findIndex((repo) => repo.id === params.repoId) ?? -1
      if (index < 0) throw new HttpError(404, '仓库不存在')
      const merged = { ...config.repos![index], ...input, id: params.repoId }
      config.repos![index] = repoBinding(Object.fromEntries(Object.entries(merged).filter(([, value]) => value !== null)))
    })
    return spaceDetail(stores)
  })
  add('POST', '/api/space/repos/:repoId/sync', async ({ stores, request, params }) => {
    authorize(request, stores, 'maintainer')
    const input = await body(request)
    const reason = text(input.reason, 'reason')
    if (!stores.config.repos?.some((repo) => repo.id === params.repoId)) throw new HttpError(404, '仓库不存在')
    const result = await repoManager(stores).sync(params.repoId!)
    await auditSpace(stores, actor(request, stores), reason, `同步仓库 ${params.repoId}：${result.head}`)
    return result
  })
  add('GET', '/api/space/files', async ({ stores, url }) => {
    const file = await spaceFile(stores, url.searchParams.get('kind'), url.searchParams.get('name'))
    if (!await access(join(stores.projectDir, file.path)).then(() => true, () => false)) throw new HttpError(404, '文件不存在')
    return file
  })
  add('PUT', '/api/space/files', async ({ stores, url, request }) => {
    authorize(request, stores, 'maintainer')
    const input = await body(request)
    const content = text(input.content, 'content', true)
    const reason = text(input.reason, 'reason')
    const file = await spaceFile(stores, url.searchParams.get('kind'), url.searchParams.get('name'))
    await auditSpace(stores, actor(request, stores), reason, `编辑 ${file.path}`)
    await atomicWrite(join(stores.projectDir, file.path), content)
    return { ...file, content }
  })
  add('GET', '/api/requirements/:id/reviews', async ({ stores, params }) => {
    await requirement(stores, params.id!)
    return listReviews(stores, params.id!)
  })
  add('GET', '/api/requirements/:id/room', async ({ stores, params }) => {
    const req = await requirement(stores, params.id!)
    return { ...await stores.chat.ensureRoom(req.id, { title: req.title }), lead: options.getLeadPresence?.(stores.projectDir, req.id) ?? { state: 'idle', since: req.createdAt } }
  })
  add('POST', '/api/requirements/:id/room/members', async ({ stores, params, request }) => {
    await requirement(stores, params.id!)
    const input = await jsonBody(request)
    const entries = Array.isArray(input) ? input : (input as Record<string, unknown> | null)?.members
    if (!Array.isArray(entries)) throw new HttpError(400, 'members 必须是数组')
    const value = entries.map((member: RoomMember) => {
      if (!member || !['human', 'lead', 'agent'].includes(member.kind)) throw new HttpError(400, '群成员类型不合法')
      return { id: text(member.id, 'id'), name: text(member.name, 'name'), kind: member.kind, ...(member.role ? { role: text(member.role, 'role') } : {}) }
    })
    return stores.chat.addMembers(params.id!, value)
  })
  add('GET', '/api/requirements/:id/chat', async ({ stores, params, url }) => {
    await requirement(stores, params.id!)
    return stores.chat.list(params.id!, { afterSeq: integer(url.searchParams.get('after'), 'after'), limit: integer(url.searchParams.get('limit'), 'limit', 1) })
  })
  add('POST', '/api/requirements/:id/chat', async ({ stores, params, request }) => {
    await requirement(stores, params.id!)
    const input = await body(request)
    const content = text(input.text, 'text')
    if (input.mentions !== undefined && (!Array.isArray(input.mentions) || input.mentions.some((id) => typeof id !== 'string'))) throw new HttpError(400, 'mentions 必须是字符串数组')
    const mentions = [...new Set([...(input.mentions as string[] ?? []), ...(/(^|\s)@lead\b/i.test(content) ? ['lead'] : [])])]
    const message = await stores.chat.post(params.id!, { text: content, kind: 'text', author: actor(request, stores), mentions,
      ...(input.replyTo === undefined ? {} : { replyTo: text(input.replyTo, 'replyTo') }) })
    if (mentions.includes('lead') && onLeadMention) void Promise.resolve().then(() => onLeadMention(params.id!, message)).catch(async (error: unknown) => {
      await stores.chat.post(params.id!, { kind: 'system', author: { type: 'system', id: 'server' }, replyTo: message.id, text: `Lead 回调失败：${error instanceof Error ? error.message : String(error)}` })
    }).catch(() => {})
    return message
  })
  add('GET', '/api/requirements/:id/chat/stream', async ({ stores, params, request, response, url }) => {
    await requirement(stores, params.id!)
    const cursor = url.searchParams.get('after') ?? (typeof request.headers['last-event-id'] === 'string' ? request.headers['last-event-id'] : null)
    // 复用运行 SSE 的先订阅再回放和 seq 去重；消息仍保持原协议，未转换为事件信封。
    const chat = stores.chat
    const id = params.id!
    await stream({ read: (_, opts) => chat.list(id, opts), subscribe: (_, send) => chat.subscribe(id, send) },
      id, integer(cursor, 'after') ?? 0, response, connections)
    const send = (presence: import('@taktflow/core').LeadPresence) => { if (!response.destroyed) response.write(`event: lead\ndata: ${JSON.stringify(presence)}\n\n`) }
    const unsubscribe = options.subscribeLead?.(stores.projectDir, id, send)
    response.once('close', () => unsubscribe?.())
    send(options.getLeadPresence?.(stores.projectDir, id) ?? { state: 'idle', since: new Date().toISOString() })
    return STREAMING
  })
}
