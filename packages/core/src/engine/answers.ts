import { join } from 'node:path'
import type { AttentionItem, ProjectStores } from '../interfaces.js'
import type { Actor } from '../types.js'
import { AttentionAlreadyAnsweredError } from '../store/attention-rules.js'
import { withFileLock } from '../store/file-lock.js'
import { runDir } from '../store/paths.js'
import { system } from './actor.js'

export function recordAnswerOnce(stores: ProjectStores, runId: string, item: AttentionItem, actor?: Actor): Promise<void> {
  return withFileLock(join(runDir(stores.taktDir, runId), 'answer-audit'), async () => {
    const events = await stores.events.read(runId, { nodeId: item.nodeId, types: ['human.answered'] })
    if (events.some((event) => (event.data as { requestId: string }).requestId === item.requestId)) return
    await stores.events.append(runId, { type: 'human.answered', nodeId: item.nodeId,
      actor: item.answeredBy ?? actor ?? system,
      data: { requestId: item.requestId, decision: item.decision, answer: item.answer,
        boundTo: item.boundTo ?? (await stores.runs.get(runId))?.nodes[item.nodeId]?.inputs },
    })
  })
}

export async function answerOrRead(stores: ProjectStores, item: AttentionItem, input: { decision?: string; answer?: string; by: Actor }): Promise<AttentionItem> {
  const boundTo = item.boundTo ?? (await stores.runs.get(item.runId))?.nodes[item.nodeId]?.inputs
  try { return await stores.attention.answer(item.requestId, { ...input, boundTo }) } catch (error) {
    if (!(error instanceof AttentionAlreadyAnsweredError)) throw error
    const answered = (await stores.attention.list({ requirementId: item.requirementId })).find((current) => current.requestId === item.requestId)
    if (!answered?.answeredAt) throw error
    return answered
  }
}
