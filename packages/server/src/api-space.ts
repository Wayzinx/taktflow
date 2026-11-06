import { join } from 'node:path'
import { access } from 'node:fs/promises'
import { listReviews, type Actor, type ProjectStores, type RoomMember, type RoomMessage } from '@taktflow/core'
import { ApiError as HttpError } from './errors.js'
import { integer, text } from './validation.js'
import { atomicWrite, auditSpace, changeConfig, members, repoBinding, repoManager, spaceDetail, spaceFile } from './space.js'
import { requirement } from './read-model.js'

export type LeadMention = (requirementId: string, message: RoomMessage) => void | Promise<void>
export type SpaceReadOp = 'space' | 'space.file' | 'reviews' | 'room' | 'chat'
export type SpaceWriteOp = 'space.members' | 'space.repo.add' | 'space.repo.update' | 'space.repo.sync' | 'space.file.edit' | 'room.members' | 'chat.send'
interface Context {
  stores: ProjectStores
  params: Record<string, string | undefined>
  input: Record<string, unknown>
  author: Actor
}

export async function readSpace(stores: ProjectStores, op: Exclude<SpaceReadOp, 'room'>, params: Context['params'], workflows?: () => Promise<import('@taktflow/core').WorkflowSummary[]>): Promise<unknown> {
  switch (op) {
    case 'space': {
      return spaceDetail(stores, workflows)
    }
    case 'space.file': {
      const file = await spaceFile(stores, params.kind ?? null, params.name ?? null)
      if (!await access(join(stores.projectDir, file.path)).then(() => true, () => false)) throw new HttpError(404, '文件不存在')
      return file
    }
    case 'reviews': {
      await requirement(stores, params.id!)
      return listReviews(stores, params.id!)
    }
    case 'chat': {
      await requirement(stores, params.id!)
      return stores.chat.list(params.id!, { afterSeq: integer(params.after, 'after'), limit: integer(params.limit, 'limit', 1) })
    }
  }
}

export async function writeSpace({ stores, params, input, author }: Context, op: SpaceWriteOp, onMessage?: (stores: ProjectStores, id: string, message: RoomMessage) => void | Promise<void>): Promise<unknown> {
  switch (op) {
    case 'space.members': {
      const value = members(input.members)
      const reason = input.reason
      await changeConfig(stores, author, text(reason, 'reason'), '更新空间成员', (config) => { config.members = value })
      return spaceDetail(stores)
    }
    case 'space.repo.add': {
      const repo = repoBinding(input)
      await changeConfig(stores, author, text(input.reason, 'reason'), `绑定仓库 ${repo.id}`, (config) => {
        if (config.repos?.some((item) => item.id === repo.id)) throw new HttpError(409, '仓库已绑定')
        config.repos = [...config.repos ?? [], repo]
      })
      return spaceDetail(stores)
    }
    case 'space.repo.update': {
      await changeConfig(stores, author, text(input.reason, 'reason'), `更新仓库 ${params.repoId}`, (config) => {
        const index = config.repos?.findIndex((repo) => repo.id === params.repoId) ?? -1
        if (index < 0) throw new HttpError(404, '仓库不存在')
        const merged = { ...config.repos![index], ...input, id: params.repoId }
        config.repos![index] = repoBinding(Object.fromEntries(Object.entries(merged).filter(([, value]) => value !== null)))
      })
      return spaceDetail(stores)
    }
    case 'space.repo.sync': {
      const reason = text(input.reason, 'reason')
      if (!stores.config.repos?.some((repo) => repo.id === params.repoId)) throw new HttpError(404, '仓库不存在')
      const result = await repoManager(stores).sync(params.repoId!)
      await auditSpace(stores, author, reason, `同步仓库 ${params.repoId}：${result.head}`)
      return result
    }
    case 'space.file.edit': {
      const content = text(input.content, 'content', true)
      const reason = text(input.reason, 'reason')
      const file = await spaceFile(stores, params.kind ?? null, params.name ?? null)
      await auditSpace(stores, author, reason, `编辑 ${file.path}`)
      await atomicWrite(join(stores.projectDir, file.path), content)
      return { ...file, content }
    }
    case 'room.members': {
      await requirement(stores, params.id!)
      const entries = input.members
      if (!Array.isArray(entries)) throw new HttpError(400, 'members 必须是数组')
      const value = entries.map((member: RoomMember) => {
        if (!member || !['human', 'lead', 'agent'].includes(member.kind)) throw new HttpError(400, '群成员类型不合法')
        return { id: text(member.id, 'id'), name: text(member.name, 'name'), kind: member.kind, ...(member.role ? { role: text(member.role, 'role') } : {}) }
      })
      return stores.chat.addMembers(params.id!, value)
    }
    case 'chat.send': {
      await requirement(stores, params.id!)
      const content = text(input.text, 'text')
      if (input.mentions !== undefined && (!Array.isArray(input.mentions) || input.mentions.some((id) => typeof id !== 'string'))) throw new HttpError(400, 'mentions 必须是字符串数组')
      const mentions = [...new Set([...(input.mentions as string[] ?? []), ...(/(^|\s)@lead\b/i.test(content) ? ['lead'] : [])])]
      const message = await stores.chat.post(params.id!, { text: content, kind: 'text', author, mentions,
        ...(input.replyTo === undefined ? {} : { replyTo: text(input.replyTo, 'replyTo') }) })
      await onMessage?.(stores, params.id!, message)
      return message
    }
  }
}
