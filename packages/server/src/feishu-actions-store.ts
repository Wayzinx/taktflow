import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { assertNoSymlinks, readJsonFile, writeFileAtomic } from '@taktflow/core'
import { spaceLock } from './space-lock.js'

export interface FeishuScope { spaceId: string; revision: string; chatId?: string }
interface WorkflowChoice { token: string; id: string; title: string }
type Decision = 'approve' | 'reject'
type CardData =
  | { kind: 'draft'; text: string; discussion: string; workflows: WorkflowChoice[] }
  | { kind: 'approval'; requestId: string; itemRevision: string; decisions: Record<Decision, string> }
export type FeishuCard = CardData & { scope: FeishuScope }

const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/
export function feishuActionStore(taktDir: string) {
  const path = (id: string) => join(taktDir, 'chat', '.feishu-actions', `${id}.json`)
  async function issue(id: string, scope: FeishuScope, make: () => Promise<CardData>) {
    const file = path(id)
    await assertNoSymlinks(taktDir, file)
    return spaceLock(file, async () => {
      const existing = await readJsonFile<FeishuCard>(file)
      if (existing) {
        if (JSON.stringify(existing.scope) !== JSON.stringify(scope)) throw new Error('飞书卡片回执的绑定不一致')
        return existing
      }
      const card = { ...await make(), scope }
      await writeFileAtomic(file, JSON.stringify(card))
      return card
    })
  }
  return {
    issue,
    async read(id: string, scope: FeishuScope) {
      if (!uuid.test(id)) return
      const file = path(id)
      await assertNoSymlinks(taktDir, file)
      const card = await readJsonFile<FeishuCard>(file)
      if (card?.scope.spaceId === scope.spaceId && card.scope.revision === scope.revision &&
        (card.scope.chatId === undefined || card.scope.chatId === scope.chatId)) return card
    },
    async approval(scope: FeishuScope, requestId: string, itemRevision: string) {
      const id = randomUUID()
      const decisions = { approve: randomUUID(), reject: randomUUID() }
      await issue(id, scope, async () => ({ kind: 'approval', requestId, itemRevision, decisions }))
      return { id, decisions }
    },
  }
}
