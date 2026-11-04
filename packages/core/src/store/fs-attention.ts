import type { AttentionItem, AttentionStore } from '../interfaces.js'
import { appendLine, readJsonLines } from './fs-utils.js'
import { withLock } from './locks.js'
import { attentionFile } from './paths.js'

type CreateInput = Parameters<AttentionStore['create']>[0]
type AnswerInput = Parameters<AttentionStore['answer']>[1]

// requestId 只是 jsonl 里的归并键，不是路径；只挡住空值和空白字符
function assertRequestId(requestId: string): string {
  if (requestId === '' || /\s/.test(requestId)) throw new Error(`非法待办 ID：${requestId}`)
  return requestId
}

export class FsAttentionStore implements AttentionStore {
  constructor(private readonly taktDir: string) {}

  async list(filter?: { pending?: boolean; requirementId?: string }): Promise<AttentionItem[]> {
    const merged = await this.merged()
    let items = [...merged.values()]
    if (filter?.pending) items = items.filter((item) => item.answeredAt === undefined)
    if (filter?.requirementId !== undefined) items = items.filter((item) => item.requirementId === filter.requirementId)
    return items
  }

  async create(item: CreateInput): Promise<AttentionItem> {
    const requestId = assertRequestId(item.requestId)
    const created: AttentionItem = { ...item, requestId, createdAt: new Date().toISOString() }
    const file = attentionFile(this.taktDir)
    await withLock(file, async () => {
      const merged = await this.merged()
      if (merged.has(requestId)) throw new Error(`待办已存在：${requestId}`)
      await appendLine(file, JSON.stringify(created))
    })
    return created
  }

  async answer(requestId: string, input: AnswerInput): Promise<AttentionItem> {
    const rid = assertRequestId(requestId)
    const file = attentionFile(this.taktDir)
    return withLock(file, async () => {
      const merged = await this.merged()
      const current = merged.get(rid)
      if (!current) throw new Error(`待办不存在：${rid}`)
      const answered: AttentionItem = { ...current, answeredAt: new Date().toISOString() }
      if (input.decision !== undefined) answered.decision = input.decision
      if (input.answer !== undefined) answered.answer = input.answer
      await appendLine(file, JSON.stringify({ ...answered, by: input.by }))
      return answered
    })
  }

  /** 只追加的 jsonl：同一 requestId 的后写覆盖先写。 */
  private async merged(): Promise<Map<string, AttentionItem>> {
    const items = await readJsonLines<AttentionItem>(attentionFile(this.taktDir))
    const merged = new Map<string, AttentionItem>()
    for (const item of items) {
      if (!item || typeof item.requestId !== 'string' || item.requestId === '') {
        throw new Error(`attention.jsonl 里有缺 requestId 的记录：${attentionFile(this.taktDir)}`)
      }
      merged.set(item.requestId, item)
    }
    return merged
  }
}
