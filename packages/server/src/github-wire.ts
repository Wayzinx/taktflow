import { createHmac, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import { sha256 } from '@taktflow/core'
import { HttpError } from './http.js'

export const githubCallbackPath = '/api/github/events'
export const object = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
const numeric = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0
const identifier = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const repository = /^[a-z\d][a-z\d-]*\/[a-z\d._-]+$/i

export interface GithubBinding { repo: string; repoId: number; spaceId: string; members: Map<number, string>; privateReplies: boolean; revision: string }
export interface GithubApp { secret: string; token: string; botId: number; login: string; bindings: Map<number, GithubBinding> }

export function githubConfig(env: NodeJS.ProcessEnv): GithubApp | undefined {
  if (!env.TAKT_GITHUB_BINDINGS) return
  const secret = env.TAKT_GITHUB_WEBHOOK_SECRET
  const token = env.TAKT_GITHUB_TOKEN
  const botId = Number(env.TAKT_GITHUB_BOT_ID)
  const login = env.TAKT_GITHUB_BOT_LOGIN?.toLowerCase()
  if (!secret || !token || !numeric(botId) || !login || !/^[a-z\d-]{1,39}$/.test(login)) throw new Error('GitHub 缺少有效的 webhook secret、bot token、数字 ID 或登录名')
  const rows: unknown = JSON.parse(env.TAKT_GITHUB_BINDINGS)
  if (!Array.isArray(rows)) throw new Error('TAKT_GITHUB_BINDINGS 需要 JSON 数组')
  const bindings = new Map<number, GithubBinding>()
  for (const row of rows) {
    const item = object(row)
    if (!item || typeof item.repo !== 'string' || !repository.test(item.repo) || !numeric(item.repoId) || bindings.has(item.repoId)
        || typeof item.spaceId !== 'string' || !identifier.test(item.spaceId) || (item.privateReplies !== undefined && typeof item.privateReplies !== 'boolean')
        || !object(item.members)) throw new Error('GitHub 绑定需要唯一的 repoId、owner/repo、spaceId 和成员映射')
    const members = new Map<number, string>()
    for (const [key, member] of Object.entries(item.members as object)) {
      const id = Number(key)
      if (!numeric(id) || String(id) !== key || id === botId || typeof member !== 'string' || !member.trim() || member === 'web') throw new Error('GitHub 成员映射无效')
      members.set(id, member)
    }
    bindings.set(item.repoId, { repo: item.repo.toLowerCase(), repoId: item.repoId, spaceId: item.spaceId, members,
      privateReplies: item.privateReplies === true, revision: sha256(JSON.stringify([botId, login, row])) })
  }
  return { secret, token, botId, login, bindings }
}

export type GithubCommand = { mode: 'chat'; text: string } | { mode: 'workflow'; workflowId: string; includeDiscussion: false; text: string } | { mode: 'vibe'; nodeId: string; text: string }
export interface GithubComment {
  repoId: number; issueId: number; issueNumber: number; commentId: number; userId: number; createdAt: string; command: GithubCommand
}

export function commandFrom(body: unknown, login: string): GithubCommand | undefined {
  if (typeof body !== 'string' || body.length > 32_000) return
  const match = /^@([a-z\d-]+)\s+([\s\S]+)$/i.exec(body.trim())
  if (!match || match[1]!.toLowerCase() !== login) return
  const message = match[2]!.trim()
  if (!message) return
  if (!message.startsWith('/')) return { mode: 'chat', text: message }
  const chat = /^\/chat\s+([\s\S]+)$/.exec(message)
  if (chat) return { mode: 'chat', text: chat[1]!.trim() }
  const action = /^\/(workflow|vibe)\s+(\S+)\s+([\s\S]+)$/.exec(message)
  if (!action || !identifier.test(action[2]!) || !action[3]!.trim()) return
  const text = action[3]!.trim()
  return action[1] === 'vibe' ? { mode: 'vibe', nodeId: action[2]!, text }
    : !action[2]!.endsWith('.ts') ? { mode: 'workflow', workflowId: action[2]!, includeDiscussion: false, text } : undefined
}

export async function githubEvent(req: IncomingMessage, app: GithubApp): Promise<GithubComment | undefined> {
  if (req.method !== 'POST') throw new HttpError(405, 'GitHub 回调需要 POST')
  const chunks: Buffer[] = []
  let bytes = 0
  for await (const chunk of req) {
    const data = Buffer.from(chunk)
    bytes += data.length
    if (bytes > 1024 * 1024) throw new HttpError(413, 'GitHub 回调超过大小限制')
    chunks.push(data)
  }
  const body = Buffer.concat(chunks)
  const sig = req.headers['x-hub-signature-256']
  if (typeof sig !== 'string' || !/^sha256=[a-f\d]{64}$/.test(sig)
    || !timingSafeEqual(createHmac('sha256', app.secret).update(body).digest(), Buffer.from(sig.slice(7), 'hex'))) throw new HttpError(401, 'GitHub 签名无效')
  if (req.headers['x-github-event'] !== 'issue_comment') return
  let data: Record<string, unknown> | undefined
  try { data = object(JSON.parse(body.toString('utf8'))) } catch { throw new HttpError(400, 'GitHub 回调格式无效') }
  if (data?.action !== 'created') return
  const repo = object(data.repository), issue = object(data.issue), sender = object(data.sender), comment = object(data.comment)
  const user = object(comment?.user)
  if (!numeric(repo?.id) || !numeric(issue?.id) || !numeric(issue.number) || issue.pull_request || issue.state !== 'open'
    || !numeric(comment?.id) || !numeric(user?.id) || user.type !== 'User' || user.id !== sender?.id || user.id === app.botId) return
  const binding = app.bindings.get(repo.id)
  if (!binding || typeof repo.full_name !== 'string' || binding.repo !== repo.full_name.toLowerCase() || !binding.members.has(user.id)) return
  if (typeof comment.created_at !== 'string') return
  const age = Date.now() - Date.parse(comment.created_at)
  if (!Number.isFinite(age) || age < -300_000 || age > 24 * 3600_000) return
  const command = commandFrom(comment.body, app.login)
  if (!command) return
  return { repoId: repo.id, issueId: issue.id, issueNumber: issue.number, commentId: comment.id, userId: user.id, createdAt: comment.created_at, command }
}
