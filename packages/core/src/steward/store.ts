import { AsyncLocalStorage } from 'node:async_hooks'
import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import { readdir, stat, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import type {
  Proposal,
  StewardFeedItem,
  StewardMessage,
  StewardPrefs,
  StewardStreamEvent,
  StewardThread,
  StewardThreadPatch,
} from '../api.js'
import {
  appendLine,
  assertNoSymlinks,
  isEnoent,
  readFileIfExists,
  readJsonFile,
  readJsonLines,
  writeFileAtomic,
} from '../store/fs-utils.js'
import { withFileLock } from '../store/file-lock.js'
import { threadMetadata } from './thread-metadata.js'
import { stewardId, StewardError } from './contracts.js'

const scope = new AsyncLocalStorage<Map<string, { active: boolean }>>()
/** 会话标题：第一句话的前 20 个字，截断时带省略号，换行折成空格。 */
const threadTitle = (text: string) => {
  const chars = [...text.replace(/\s+/g, ' ').trim()]
  return chars.length > 20 ? `${chars.slice(0, 20).join('')}…` : chars.join('')
}
/** 会话列表摘要是纯文本：链接留文字，去掉粗体 / 行内代码 / 代码围栏 / 标题井号 / 表格竖线（[n] 引用由页面去）。 */
const summary = (text: string) =>
  text
    .replace(/^```.*$/gm, '')
    .replace(/^\s*\|?[\s:|-]*-{2,}[\s:|-]*$/gm, '')
    .replace(/\[([^\]\n]+)\]\((?:\[\d+\]|[^)\s]*)\)/g, '$1')
    .replace(/\*\*|__|`/g, '')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\s*\|\s*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160)
const buses = new Map<string, EventEmitter>()
export class StewardStore {
  private unreadCache?: { seen: string; size: number; count: number }
  readonly dir: string
  private readonly bus: EventEmitter
  constructor(dir: string, private readonly requirementTitle?: (spaceId: string, id: string) => Promise<string | undefined>) {
    this.dir = resolve(dir)
    let bus = buses.get(this.dir)
    if (!bus) {
      bus = new EventEmitter()
      bus.setMaxListeners(0)
      buses.set(this.dir, bus)
    }
    this.bus = bus
  }
  async serial<T>(work: () => Promise<T>): Promise<T> {
    if (scope.getStore()?.get(this.dir)?.active) return work()
    await assertNoSymlinks(dirname(dirname(this.dir)), this.dir)
    return withFileLock(join(this.dir, 'write'), async () => {
      const token = { active: true },
        context = new Map(scope.getStore())
      context.set(this.dir, token)
      try {
        return await scope.run(context, work)
      } finally {
        token.active = false
      }
    })
  }
  private async path(file: string) {
    if (file.split('/').some((part) => part === '..') || file.startsWith('/'))
      throw new StewardError(400, '存储路径非法，请检查标识')
    const target = join(this.dir, file)
    await assertNoSymlinks(dirname(dirname(this.dir)), target)
    return target
  }
  async read<T>(file: string): Promise<T | undefined> {
    return readJsonFile<T>(await this.path(file))
  }
  async lines<T>(file: string): Promise<T[]> {
    return readJsonLines<T>(await this.path(file))
  }
  async text(file: string): Promise<string> {
    return (await readFileIfExists(await this.path(file)))?.toString('utf8') ?? ''
  }
  write(file: string, value: unknown): Promise<void> {
    return this.writeText(file, `${JSON.stringify(value, null, 2)}\n`)
  }
  writeText(file: string, value: string): Promise<void> {
    return this.serial(async () => writeFileAtomic(await this.path(file), value))
  }
  append(file: string, value: unknown): Promise<void> {
    return this.serial(async () => appendLine(await this.path(file), JSON.stringify(value)))
  }
  async list<T>(folder: string): Promise<T[]> {
    let files: string[]
    try {
      files = await readdir(await this.path(folder))
    } catch (error) {
      if (isEnoent(error)) return []
      throw error
    }
    const rows = await Promise.all(
      files
        .filter((file) => /^[\w-]+\.json$/.test(file))
        .map((file) => this.read<T>(`${folder}/${file}`)),
    )
    return rows.filter((row) => row !== undefined) as T[]
  }
  async thread(id: string): Promise<StewardThread> {
    const row = await this.read<StewardThread>(`threads/${stewardId(id)}.json`)
    if (!row) throw new StewardError(404, '会话不存在，请新建会话')
    const missingTitle = (thread: StewardThread) => this.requirementTitle && thread.spaceId && thread.requirementId && (!thread.requirementTitle || thread.requirementTitle === thread.requirementId)
    if (row.messageCount === undefined || missingTitle(row)) return this.serial(async () => {
      const current = await this.read<StewardThread>(`threads/${id}.json`)
      if (!current) throw new StewardError(404, '会话已删除，请新建会话')
      if (current.messageCount === undefined) Object.assign(current, await this.metadata(current, await this.messageRows(id)))
      else if (missingTitle(current)) current.requirementTitle = await this.requirementTitle!(current.spaceId!, current.requirementId!)
      else return current
      await this.write(`threads/${id}.json`, current)
      return current
    })
    return row
  }
  private async metadata(thread: StewardThread, messages: StewardMessage[]) {
    const metadata = threadMetadata(thread, messages)
    if (metadata.spaceId && metadata.requirementId && !metadata.requirementTitle && this.requirementTitle)
      metadata.requirementTitle = await this.requirementTitle(metadata.spaceId, metadata.requirementId)
    return metadata
  }
  async patchThread(id: string, patch: StewardThreadPatch, at = new Date().toISOString()): Promise<StewardThread> {
    if (Object.keys(patch).some(key => !['title', 'pinned', 'archived', 'runtime'].includes(key)))
      throw new StewardError(400, '会话修改包含未知字段，请刷新后重试')
    if (patch.title !== undefined && (typeof patch.title !== 'string' || [...patch.title.trim()].length < 1 || [...patch.title.trim()].length > 80))
      throw new StewardError(400, '标题需要 1–80 字，请修改后重试')
    for (const key of ['pinned', 'archived'] as const)
      if (patch[key] !== undefined && typeof patch[key] !== 'boolean') throw new StewardError(400, '置顶或归档需要布尔值，请重新选择')
    return this.serial(async () => {
      const thread = await this.thread(id)
      if (patch.title !== undefined) { thread.title = patch.title.trim(); thread.titleEdited = true }
      if (patch.pinned !== undefined) thread.pinnedAt = patch.pinned ? thread.pinnedAt ?? at : undefined
      if (patch.archived !== undefined) thread.archivedAt = patch.archived ? thread.archivedAt ?? at : undefined
      if (patch.runtime !== undefined) thread.runtime = patch.runtime ?? undefined
      await this.write(`threads/${thread.id}.json`, thread)
      return thread
    })
  }
  async setStatus(id: string, status?: StewardThread['status'], error?: string): Promise<void> {
    await this.serial(async () => {
      const thread = await this.thread(id)
      await this.write(`threads/${thread.id}.json`, { ...thread, status, error })
    })
  }
  /** 服务重启：上次没回完的回复标成中断，否则页面会一直显示它在跑。 */
  async interruptReplies(): Promise<void> {
    await this.serial(async () => {
      for (const thread of await this.list<StewardThread>('threads')) {
        if (thread.status !== 'replying') continue
        for (const message of await this.messages(thread.id))
          if (message.status === 'streaming') await this.saveMessage({ ...message, status: 'stopped', error: '服务重启时这条回复还没写完' })
        await this.setStatus(thread.id, 'interrupted')
      }
    })
  }
  async deleteThread(id: string): Promise<void> {
    await this.serial(async () => {
      const thread = await this.thread(id)
      const count = (await this.list<Proposal>('proposals')).filter(p => p.threadId === id && p.status === 'pending').length
      if (count) throw new StewardError(409, `这个会话还有 ${count} 个待决定的提案，先处理或归档`)
      if (thread.status === 'replying') throw new StewardError(409, '这个会话正在回复，请等回复结束后再删除')
      await rm(await this.path(`threads/${id}.jsonl`), { force: true })
      await rm(await this.path(`threads/${id}.json`), { force: true })
    })
  }
  async threads(search = '', archived: boolean | null = false): Promise<StewardThread[]> {
    return (await Promise.all((await this.list<StewardThread>('threads')).map(t => this.thread(t.id))))
      .filter(t => archived === null || Boolean(t.archivedAt) === archived)
      .filter((t) => t.title.toLowerCase().includes(search.toLowerCase()))
      .sort((a, b) => Number(Boolean(b.pinnedAt)) - Number(Boolean(a.pinnedAt)) || (a.pinnedAt && b.pinnedAt ? b.pinnedAt.localeCompare(a.pinnedAt) : b.updatedAt.localeCompare(a.updatedAt)))
  }
  async createThread(
    text: string,
    at: string,
    context?: StewardThread['context'],
    runtime?: StewardThread['runtime'],
  ): Promise<StewardThread> {
    const thread: StewardThread = {
      id: randomUUID(),
      title: threadTitle(text),
      createdAt: at,
      updatedAt: at,
      context,
      ...(runtime === undefined ? {} : { runtime }),
    }
    Object.assign(thread, await this.metadata(thread, []))
    await this.write(`threads/${thread.id}.json`, thread)
    return thread
  }
  async messages(id: string): Promise<StewardMessage[]> {
    await this.thread(id)
    return this.messageRows(id)
  }
  private async messageRows(id: string): Promise<StewardMessage[]> {
    return [
      ...new Map(
        (await this.lines<StewardMessage>(`threads/${id}.jsonl`)).map((message) => [
          message.id,
          message,
        ]),
      ).values(),
    ]
  }
  saveMessage(message: StewardMessage): Promise<void> {
    return this.serial(async () => {
      const thread = await this.thread(message.threadId)
      await this.append(`threads/${thread.id}.jsonl`, message)
      await this.write(`threads/${thread.id}.json`, {
        ...thread,
        ...await this.metadata(thread, await this.messageRows(thread.id)),
        updatedAt: message.at > thread.updatedAt ? message.at : thread.updatedAt,
        lastMessage: summary(message.text),
      })
    })
  }
  async proposal(id: string): Promise<Proposal> {
    const proposal = await this.read<Proposal>(`proposals/${stewardId(id)}.json`)
    if (!proposal) throw new StewardError(404, '提案不存在，请刷新列表')
    return proposal
  }
  async saveProposal(proposal: Proposal): Promise<void> {
    await this.serial(async () => {
      await this.write(`proposals/${stewardId(proposal.id)}.json`, proposal)
      const thread = await this.read<StewardThread>(`threads/${stewardId(proposal.threadId)}.json`)
      if (!thread) return
      const count = (await this.list<Proposal>('proposals')).filter(
        (p) => p.threadId === thread.id && p.status === 'pending',
      ).length
      await this.write(`threads/${thread.id}.json`, { ...thread, pendingProposals: count })
    })
  }
  async prefs(): Promise<StewardPrefs> {
    return (
      (await this.read<StewardPrefs>('prefs.json')) ?? {
        trust: 'confirm',
        digestTimes: ['09:30', '18:00'],
      }
    )
  }
  emit(thread: string, event: StewardStreamEvent): void {
    this.bus.emit(`thread:${thread}`, event)
  }
  onThread(thread: string, listener: (event: StewardStreamEvent) => void): () => void {
    this.bus.on(`thread:${thread}`, listener)
    return () => {
      this.bus.off(`thread:${thread}`, listener)
    }
  }
  async feed(item: StewardFeedItem): Promise<void> {
    await this.serial(async () => {
      const file = await this.path('feed.jsonl')
      const seen = (await this.read<{ at: string }>('seen.json'))?.at ?? ''
      const size = await stat(file).then(
        (info) => info.size,
        (error) => {
          if (isEnoent(error)) return 0
          throw error
        },
      )
      const cached = this.unreadCache
      let count =
        cached?.seen === seen && cached.size === size
          ? cached.count
          : (await this.lines<StewardFeedItem>('feed.jsonl')).filter((entry) => entry.at > seen)
              .length
      await this.append('feed.jsonl', item)
      if (item.at > seen) count++
      this.unreadCache = {
        seen,
        size: size + Buffer.byteLength(JSON.stringify(item) + '\n'),
        count,
      }
      this.bus.emit('feed', item)
      if (item.type !== 'unread')
        this.bus.emit('feed', { type: 'unread', at: item.at, count } satisfies StewardFeedItem)
    })
  }
  onFeed(listener: (item: StewardFeedItem) => void): () => void {
    this.bus.on('feed', listener)
    return () => {
      this.bus.off('feed', listener)
    }
  }
}
