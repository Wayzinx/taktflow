import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type { ChatStore } from '../interfaces.js'
import type { Room, RoomMember, RoomMessage } from '../types.js'
import { assertRequirementId } from './paths.js'
import { appendLine, assertNoSymlinks, readJsonFile, readJsonLines, toJsonText, writeFileAtomic } from './fs-utils.js'
import { withFileLock } from './file-lock.js'
import { subscribeJsonLines } from './jsonl-tail.js'

export class FsChatStore implements ChatStore {
  constructor(private readonly taktDir: string) {}
  private file(id: string, name: string): string {
    return join(this.taktDir, 'chat', assertRequirementId(id), name)
  }
  async getRoom(id: string): Promise<Room | undefined> {
    const file = this.file(id, 'room.json')
    await assertNoSymlinks(this.taktDir, file)
    return readJsonFile<Room>(file)
  }
  async ensureRoom(id: string, input: { title?: string; members?: RoomMember[] } = {}): Promise<Room> {
    const file = this.file(id, 'room.json')
    await assertNoSymlinks(this.taktDir, file)
    return withFileLock(file, async () => {
      const existing = await this.getRoom(id)
      if (existing) return existing
      const room: Room = { id, requirementId: id, title: input.title ?? id,
        members: [...new Map((input.members ?? []).map((member) => [member.id, member])).values()], createdAt: new Date().toISOString() }
      await writeFileAtomic(file, toJsonText(room))
      return room
    })
  }
  async addMembers(id: string, members: RoomMember[]): Promise<Room> {
    await this.ensureRoom(id)
    return withFileLock(this.file(id, 'room.json'), async () => {
      const room = (await this.getRoom(id))!
      room.members = [...new Map([...room.members, ...members].map((member) => [member.id, member])).values()]
      await writeFileAtomic(this.file(id, 'room.json'), toJsonText(room))
      return room
    })
  }
  async list(id: string, opts: { afterSeq?: number; limit?: number } = {}): Promise<RoomMessage[]> {
    const file = this.file(id, 'messages.jsonl')
    await assertNoSymlinks(this.taktDir, file)
    const messages = (await readJsonLines<RoomMessage>(file)).filter((message) => message.seq > (opts.afterSeq ?? 0))
    return opts.limit === undefined ? messages : messages.slice(0, Math.max(0, opts.limit))
  }
  async post(id: string, input: Omit<RoomMessage, 'id' | 'roomId' | 'seq' | 'at'>): Promise<RoomMessage> {
    await this.ensureRoom(id)
    const file = this.file(id, 'messages.jsonl')
    await assertNoSymlinks(this.taktDir, file)
    return withFileLock(file, async () => {
      const messages = await this.list(id)
      const message: RoomMessage = { ...input, id: randomUUID(), roomId: id, seq: (messages.at(-1)?.seq ?? 0) + 1, at: new Date().toISOString() }
      await appendLine(file, JSON.stringify(message))
      return message
    })
  }
  subscribe(id: string, onMessage: (message: RoomMessage) => void): () => void {
    return subscribeJsonLines(this.file(id, 'messages.jsonl'), onMessage)
  }
}
