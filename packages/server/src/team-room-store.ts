import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { assertNoSymlinks, sha256 } from '@taktflow/core'
import { HttpError } from './http.js'
import { atomicWrite } from './space.js'
import { spaceLock } from './space-lock.js'

export interface TeamMessage {
  id: string
  role: 'human' | 'steward'
  author: string
  text: string
  at: string
  requirementId?: string
  runId?: string
  jobId?: string
  startError?: string
}

export type TeamReply = Pick<TeamMessage, 'text' | 'requirementId' | 'runId' | 'jobId' | 'startError'>
interface Receipt { id: string; fingerprint: string; finished?: true }
interface Room { messages: TeamMessage[]; receipts: Record<string, Receipt> }

export function teamRoomStore(taktDir: string) {
  const file = join(taktDir, 'chat', '.team-room.json')
  const read = async (): Promise<Room> => {
    await assertNoSymlinks(taktDir, file)
    try { return JSON.parse(await readFile(file, 'utf8')) as Room }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { messages: [], receipts: {} }
      throw new Error('读取团队会话失败', { cause: error })
    }
  }
  return {
    async messages() { return (await read()).messages },
    async submit(author: string, requestId: string, input: object, text: string,
      respond: (id: string, history: TeamMessage[], interrupted: boolean) => Promise<TeamReply>) {
      const key = sha256(JSON.stringify([author, requestId]))
      const fingerprint = sha256(JSON.stringify(input))
      return spaceLock(`${file}.${key}`, async () => {
        const { receipt, history, interrupted } = await spaceLock(file, async () => {
          const room = await read()
          const existing = room.receipts[key]
          if (existing) {
            if (existing.fingerprint !== fingerprint) throw new HttpError(409, 'requestId 已用于不同的团队消息')
            const index = room.messages.findIndex(message => message.id === existing.id)
            if (index < 0) throw new Error('团队消息缺少请求对应的发言')
            return { receipt: existing, history: room.messages.slice(0, index), interrupted: true }
          }
          const receipt: Receipt = { id: randomUUID(), fingerprint }
          const history = room.messages.slice()
          room.receipts[key] = receipt
          room.messages.push({ id: receipt.id, role: 'human', author, text, at: new Date().toISOString() })
          await atomicWrite(file, JSON.stringify(room))
          return { receipt, history, interrupted: false }
        })
        if (receipt.finished) return
        const reply = await respond(receipt.id, history, interrupted)
        await spaceLock(file, async () => {
          const room = await read()
          room.messages.push({ ...reply, id: `${receipt.id}-reply`, role: 'steward', author: 'steward', at: new Date().toISOString() })
          room.receipts[key] = { ...receipt, finished: true }
          await atomicWrite(file, JSON.stringify(room))
        })
      })
    },
  }
}
