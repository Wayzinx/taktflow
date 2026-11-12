import { serialize } from './stale.js'
import { join } from 'node:path'
import { spaceLock } from './space-lock.js'
import { systemWrite } from '@taktflow/core'
import { access } from 'node:fs/promises'
import { assertTaskResendable, TaskResendConflictError, listReviews, type RepoBinding, type RoomMember, type RoomMessage } from '@taktflow/core'
import { authorize, actor, body, jsonBody, HttpError, integer, requires, text } from './http.js'
import { atomicWrite, auditSpace, changeConfig, checkRepoSource, members, recordRepoSync, repoBinding, repoManager, spaceDetail, spaceFile } from './space.js'
import { GitCommandError, repoWorktrees } from '@taktflow/sandbox'
import { requirement } from './read-model.js'
import { stream } from './stream.js'
import type { M3Callbacks } from './m3-routes.js'
import { STREAMING, type Handler } from './routes.js'

export type LeadMention = (requirementId: string, message: RoomMessage) => void | Promise<void>

/**
 * 同步失败给人看的原因：git stderr 里最后一行 fatal / error（去掉地址里的账号口令），或超时。
 * 不是 git 本身的失败（例如配置损坏）返回 undefined，按内部错误处理。
 */
export function syncFailure(error: unknown, repo: RepoBinding): string | undefined {
  if (error instanceof Error && /timed out/.test(error.message)) return `同步失败：git 超过 2 分钟没有完成，请检查网络或仓库大小后重试`
  if (!(error instanceof GitCommandError)) return undefined
  if (error.command === 'rev-parse') return `同步失败：仓库里没有默认分支 ${repo.defaultBranch}，请检查分支名`
  const redact = (text: string) => text.replace(/(\/\/)[^/@\s]+@/g, '$1***@')
  const lines = error.stderr.split('\n').map((line) => line.trim()).filter(Boolean).reverse()
  const line = lines.find((item) => /^(fatal|error):/i.test(item)) ?? lines[0]
  const detail = line ? redact(line.replace(/^(fatal|error):\s*/i, '')).slice(0, 300) : `退出码 ${error.code}`
  const step = error.command === 'clone' ? `克隆 ${redact(repo.url ?? repo.path)}` : error.command === 'fetch' ? '拉取远程' : `git ${error.command}`
  return `同步失败（${step}）：${detail}`
}
export function spaceRoutes(add: (method: string, path: string, handler: Handler) => void, connections: Set<() => void>, onLeadMention?: LeadMention, options: M3Callbacks = {}) {
  add('POST', '/api/requirements/:id/room/tasks/:messageId/resend', async ({ stores, params, request }) => {
    await requirement(stores, params.id!)
    const reason = text((await body(request)).reason, 'reason')
    return serialize(stores.projectDir, async () => {
      const messages = await stores.chat.list(params.id!)
      const original = messages.find(message => message.id === params.messageId)
      if (!original || original.kind !== 'task') throw new HttpError(404, '任务消息不存在；请刷新群聊')
      let message: RoomMessage | undefined
      try {
        assertTaskResendable(messages, original)
        message = await options.resendTask?.(stores.projectDir, params.id!, original, reason)
      } catch (error) {
        if (error instanceof TaskResendConflictError) throw new HttpError(409, error.message)
        throw error
      }
      if (!message) throw new HttpError(409, '当前服务没有可用的 Lead，未重发任务；请使用启用 Lead 的 takt serve 启动此空间后重试')
      await auditSpace(stores, actor(request, stores), reason, JSON.stringify({ action: 'room.task.resend', original: original.id, messageId: message.id,
        oldTaskRunId: original.refs?.taskRunId, newTaskRunId: message.refs?.taskRunId, hops: message.receipt?.hops, chain: message.receipt?.chain }))
      return message
    })
  })
  add('GET', '/api/space', ({ stores }) => spaceDetail(stores))
  add('PUT', '/api/space/members', requires('owner', '修改空间成员', async ({ stores, request }) => {
    const input = await jsonBody(request)
    const record = input as Record<string, unknown> | null
    const value = members(Array.isArray(input) ? input : record?.members)
    const reason = Array.isArray(input) ? request.headers['x-takt-reason'] : record?.reason
    await changeConfig(stores, actor(request, stores), text(reason, 'reason'), '更新空间成员', (config) => { config.members = value })
    return spaceDetail(stores)
  }))
  add('POST', '/api/space/repos', requires('maintainer', '绑定代码仓库', async ({ stores, request }) => {
    const input = await body(request)
    const repo = repoBinding(input)
    const reason = text(input.reason, 'reason')
    if (stores.config.repos?.some((item) => item.id === repo.id)) throw new HttpError(409, '仓库已绑定')
    await checkRepoSource(stores, repo)
    await changeConfig(stores, actor(request, stores), reason, `绑定仓库 ${repo.id}`, (config) => {
      if (config.repos?.some((item) => item.id === repo.id)) throw new HttpError(409, '仓库已绑定')
      config.repos = [...config.repos ?? [], repo]
    })
    return spaceDetail(stores)
  }))
  add('PATCH', '/api/space/repos/:repoId', requires('maintainer', '修改代码仓库', async ({ stores, request, params }) => {
    const input = await body(request)
    const reason = text(input.reason, 'reason')
    const current = stores.config.repos?.find((repo) => repo.id === params.repoId)
    if (current && typeof input.url === 'string') await checkRepoSource(stores, repoBinding({ ...current, ...input, id: params.repoId }))
    await changeConfig(stores, actor(request, stores), reason, `更新仓库 ${params.repoId}`, (config) => {
      const index = config.repos?.findIndex((repo) => repo.id === params.repoId) ?? -1
      if (index < 0) throw new HttpError(404, '仓库不存在')
      const merged = { ...config.repos![index], ...input, id: params.repoId }
      config.repos![index] = repoBinding(Object.fromEntries(Object.entries(merged).filter(([, value]) => value !== null)))
    })
    // 地址改了，上次同步失败的原因不再适用
    if (input.url !== undefined) await recordRepoSync(stores, params.repoId!)
    return spaceDetail(stores)
  }))
  add('POST', '/api/space/repos/:repoId/sync', requires('maintainer', '同步代码仓库', async ({ stores, request, params }) => {
    const input = await body(request)
    const reason = text(input.reason, 'reason')
    if (!stores.config.repos?.some((repo) => repo.id === params.repoId)) throw new HttpError(404, '仓库不存在')
    let result: { head: string }
    try { result = await repoManager(stores).sync(params.repoId!) } catch (error) {
      const why = syncFailure(error, stores.config.repos.find((repo) => repo.id === params.repoId)!)
      if (!why) throw error
      await recordRepoSync(stores, params.repoId!, why)
      await auditSpace(stores, actor(request, stores), reason, `同步仓库 ${params.repoId} 失败：${why}`)
      throw new HttpError(502, why)
    }
    await recordRepoSync(stores, params.repoId!)
    await auditSpace(stores, actor(request, stores), reason, `同步仓库 ${params.repoId}：${result.head}`)
    return result
  }))
  add('DELETE', '/api/space/repos/:repoId', requires('maintainer', '解绑代码仓库', async ({ stores, request, params }) => {
    const reason = text((await body(request)).reason, 'reason')
    const repo = stores.config.repos?.find((item) => item.id === params.repoId)
    if (!repo) throw new HttpError(404, '仓库不存在')
    const active = (await stores.runs.list()).filter((run) => ['running', 'waiting_human'].includes(run.status)).map((run) => run.runId)
    const busy = [...new Set((await repoWorktrees(stores, repo, active)).map((tree) => tree.runId))]
    if (busy.length) throw new HttpError(409, `还有运行中的任务在用 ${repo.id} 的工作区：${busy.join('、')}；请等它们结束或先取消运行再解绑`)
    // 只从配置里摘掉绑定：本地目录、镜像（.takt/repos/<id>，历史运行的工作区还引用它）都不删
    await changeConfig(stores, actor(request, stores), reason, `解绑仓库 ${repo.id}`, (config) => {
      config.repos = config.repos?.filter((item) => item.id !== repo.id)
    })
    await recordRepoSync(stores, repo.id)
    return spaceDetail(stores)
  }))
  add('GET', '/api/space/files', async ({ stores, url }) => {
    const file = await spaceFile(stores, url.searchParams.get('kind'), url.searchParams.get('name'))
    if (!await access(join(stores.projectDir, file.path)).then(() => true, () => false)) throw new HttpError(404, '文件不存在')
    return file
  })
  add('PUT', '/api/space/files', requires('maintainer', '编辑空间文件', async ({ stores, url, request }) => {
    if (url.searchParams.get('kind') === 'agent') authorize(request, stores, 'owner', '编辑角色档案')
    const input = await body(request)
    const content = text(input.content, 'content', true)
    const reason = text(input.reason, 'reason')
    const file = await spaceFile(stores, url.searchParams.get('kind'), url.searchParams.get('name'))
    const save = () => systemWrite(stores.projectDir, [file.path, `${file.path}.*.tmp`, '.takt/space-events.jsonl*'], async () => {
      await auditSpace(stores, actor(request, stores), reason, `编辑 ${file.path}`)
      await atomicWrite(join(stores.projectDir, file.path), content)
      return { ...file, content }
    })
    return file.kind === 'agent' ? spaceLock(join(stores.taktDir, 'agent-edit'), save) : save()
  }))
  add('GET', '/api/requirements/:id/reviews', async ({ stores, params }) => {
    await requirement(stores, params.id!)
    return listReviews(stores, params.id!)
  })
  add('GET', '/api/requirements/:id/room', async ({ stores, params }) => {
    const req = await requirement(stores, params.id!)
    const room = await stores.chat.ensureRoom(req.id, { title: req.title })
    // 建群时只知道成员 id（name 填的也是 id）：读取时按空间成员表补显示名，改名后也立即生效
    const names = new Map((stores.config.members ?? []).map((member) => [member.id, member.name]))
    const members = room.members.map((member) => member.kind === 'human' && member.name === member.id && names.get(member.id) ? { ...member, name: names.get(member.id)! } : member)
    return { ...room, members, lead: options.getLeadPresence?.(stores.projectDir, req.id) ?? { state: 'idle', since: req.createdAt } }
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
