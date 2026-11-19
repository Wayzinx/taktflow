import { join } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { openProject, type ProjectStores } from '@taktflow/core'
import { ChannelQueue, type ChannelEnvelope } from './feishu-queue.js'
import { commandFrom, githubEvent, object, type GithubApp, type GithubBinding, type GithubComment } from './github-wire.js'
import { HttpError, json } from './http.js'
import type { M3Callbacks } from './m3-routes.js'
import { storagePath, teamFileLock } from './team-storage.js'
import { spaceId } from './space.js'
import { teamRoomService } from './team-room.js'
import { teamJobs, teamNodes, enqueueTeamJob } from './team-hub.js'

interface Envelope extends ChannelEnvelope { event: GithubComment; memberId: string }
const api = 'https://api.github.com'

function githubApi(app: GithubApp, fetcher: typeof fetch) {
  return async (path: string, body?: string): Promise<unknown> => {
    const response = await fetcher(api + path, {
      method: body === undefined ? 'GET' : 'POST', redirect: 'error', signal: AbortSignal.timeout(8_000),
      headers: { authorization: `Bearer ${app.token}`, accept: 'application/vnd.github+json', 'content-type': 'application/json', 'x-github-api-version': '2022-11-28' },
      body: body === undefined ? undefined : JSON.stringify({ body }),
    })
    if (!response.ok) throw Object.assign(new Error(`GitHub 请求失败（${response.status}）`), {
      retryable: response.status === 403 || response.status === 429 || response.status >= 500,
    })
    return response.json()
  }
}

export function githubChannel(root: string, app: GithubApp | undefined, spaces: () => ProjectStores[], options: M3Callbacks, fetcher: typeof fetch = fetch) {
  if (!app) return { start() {}, close: async () => {}, callback: async () => { throw new HttpError(404, 'GitHub 渠道未启用') } }
  const call = githubApi(app, fetcher)
  const bindingFor = (entry: Envelope) => {
    const binding = app.bindings.get(entry.event.repoId)
    return binding?.spaceId === entry.spaceId && binding.revision === entry.revision && binding.members.get(entry.event.userId) === entry.memberId ? binding : undefined
  }
  const currentStores = async (entry: Envelope) => {
    const project = bindingFor(entry) && spaces().find(item => spaceId(item) === entry.spaceId)
    if (!project) return
    const fresh = await openProject(project.projectDir)
    if (spaceId(fresh) === entry.spaceId && fresh.config.members?.some(member => member.id === entry.memberId && ['owner', 'maintainer', 'member'].includes(member.role))) return fresh
  }

  const botLogin = app.login
  async function liveIssue(binding: GithubBinding, event: GithubComment) {
    const base = `/repos/${binding.repo}`
    const issuePath = `${base}/issues/${event.issueNumber}`
    const [repository, issue, source] = await Promise.all([call(base), call(issuePath), call(`${base}/issues/comments/${event.commentId}`)])
    const repo = object(repository), thread = object(issue), comment = object(source)
    if (repo?.id !== event.repoId || thread?.id !== event.issueId || thread.state !== 'open' || thread.pull_request) return
    if (comment?.id !== event.commentId || object(comment.user)?.id !== event.userId
      || typeof comment.issue_url !== 'string' || comment.issue_url.toLowerCase() !== api + issuePath
      || JSON.stringify(commandFrom(comment.body, botLogin)) !== JSON.stringify(event.command)) return
    return { private: repo.private === true && repo.visibility === 'private', comments: `${base}/issues/${event.issueNumber}/comments` }
  }

  const queue = new ChannelQueue<Envelope>(root, {
    async prepare(entry) {
      const binding = bindingFor(entry)
      const stores = await currentStores(entry)
      if (!binding || !stores || !await liveIssue(binding, entry.event)) return
      const current = async () => {
        const live = await currentStores(entry)
        if (!live) throw Object.assign(new Error('GitHub 绑定或空间权限已失效'), { retryable: false })
        return live
      }
      const room = teamRoomService(stores, options, { teamJobs, teamNodes, enqueueTeamJob }, current, 'github')
      const { reply } = await room.submit({ type: 'human', id: entry.memberId }, { ...entry.event.command, requestId: entry.key }, { operationKey: entry.key })
      return { type: 'text', content: { text: reply.text } }
    },
    deliver: (entry, message) => teamFileLock(storagePath(join(root, `send-${entry.event.repoId}-${entry.event.commentId}`)), async () => {
      const binding = bindingFor(entry)
      if (!binding || !await currentStores(entry)) return
      const identity = object(await call('/user'))
      if (identity?.id !== app.botId) throw Object.assign(new Error('GitHub Token 与配置的 bot 数字 ID 不一致'), { retryable: false })
      const { event } = entry
      const issue = await liveIssue(binding, event)
      if (!issue) return
      // GitHub 新建评论没有幂等键。遇到网络超时或进程重启，先核对同一 issue 中由本 bot 留下的回执。
      const marker = `<!-- taktflow:github:${event.repoId}:${event.commentId} -->`
      const since = encodeURIComponent(new Date(Date.parse(event.createdAt) - 1000).toISOString())
      for (let page = 1; ; page++) {
        const comments = await call(`${issue.comments}?per_page=100&page=${page}&since=${since}`)
        if (!Array.isArray(comments)) throw new Error('GitHub 评论列表无效')
        if (comments.some(row => object(row?.user)?.id === app.botId && typeof row?.body === 'string' && row.body.endsWith(marker))) return
        if (comments.length < 100) break
      }
      const fresh = await liveIssue(binding, event)
      if (!fresh || !await currentStores(entry)) return
      const reply = binding.privateReplies && fresh.private && typeof message.content.text === 'string'
        ? message.content.text.slice(0, 12_000).split('\n').map(line => '    ' + line).join('\n')
        : '空间管家已处理这条消息，已在项目空间记录回复。'
      await call(fresh.comments, `${reply}\n\n${marker}`)
    }),
  })
  return {
    start: () => queue.start(), close: () => queue.close(),
    callback: async (request: IncomingMessage, response: ServerResponse) => {
      const event = await githubEvent(request, app)
      if (event) {
        const binding = app.bindings.get(event.repoId)!
        const entry = { event, key: `github:${event.repoId}:${event.commentId}`, chatId: `${event.repoId}/${event.issueId}`,
          spaceId: binding.spaceId, revision: binding.revision, memberId: binding.members.get(event.userId)! }
        if (await currentStores(entry)) await queue.put(entry)
      }
      json(response, {}, 202)
    },
  }
}
