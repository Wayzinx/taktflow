import { AsyncLocalStorage } from 'node:async_hooks'
import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import { readdir, stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import type {
  Proposal,
  StewardFeedItem,
  StewardMessage,
  StewardPrefs,
  StewardStreamEvent,
  StewardThread,
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
import { stewardId, StewardError } from './contracts.js'

const scope = new AsyncLocalStorage<Map<string, { active: boolean }>>()
const buses = new Map<string, EventEmitter>()
export class StewardStore {
  private unreadCache?: { seen: string; size: number; count: number }
  readonly dir: string
  private readonly bus: EventEmitter
  constructor(dir: string) {
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
    return row
  }
  async threads(search = ''): Promise<StewardThread[]> {
    return (await this.list<StewardThread>('threads'))
      .filter((t) => t.title.toLowerCase().includes(search.toLowerCase()))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  }
  async createThread(
    text: string,
    at: string,
    context?: StewardThread['context'],
  ): Promise<StewardThread> {
    const thread: StewardThread = {
      id: randomUUID(),
      title: [...text].slice(0, 20).join(''),
      createdAt: at,
      updatedAt: at,
      context,
    }
    await this.write(`threads/${thread.id}.json`, thread)
    return thread
  }
  async messages(id: string): Promise<StewardMessage[]> {
    await this.thread(id)
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
        updatedAt: message.at,
        lastMessage: message.text.slice(0, 160),
      })
    })
  }
  async proposal(id: string): Promise<Proposal> {
    const proposal = await this.read<Proposal>(`proposals/${stewardId(id)}.json`)
    if (!proposal) throw new StewardError(404, '提案不存在，请刷新列表')
    return proposal
  }
  async saveProposal(proposal: Proposal): Promise<void> {
    await this.write(`proposals/${stewardId(proposal.id)}.json`, proposal)
    const thread = await this.thread(proposal.threadId)
    const count = (await this.list<Proposal>('proposals')).filter(
      (p) => p.threadId === thread.id && p.status === 'pending',
    ).length
    await this.write(`threads/${thread.id}.json`, { ...thread, pendingProposals: count })
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
