import { join } from 'node:path'
import type { AttentionItem, ProjectStores } from '../interfaces.js'
import { appendLine, readJsonFile, writeFileAtomic } from '../store/fs-utils.js'
import { attentionFile } from '../store/paths.js'
import { withFileLock } from '../store/file-lock.js'
import { recordAnswerOnce } from '../engine/answers.js'
import { rewindAffected } from '../engine/rewind.js'
import { markArtifactEdited } from '../store/artifact-edits.js'

const system = { type: 'system', id: 'timebox' } as const
export interface AttentionTickResult {
  reminded: Array<{ requestId: string; round: number; to: string[] }>
  handedBack: AttentionItem[]
  resume: string[]
  assumptions: AttentionItem[]
  stale: Array<{ runId: string; nodeId: string }>
}
export function timeboxMs(value?: string): number | undefined {
  if (value === undefined) return undefined
  const match = /^(\d+(?:\.\d+)?)(m|h|d)$/.exec(value)
  if (!match || Number(match[1]) <= 0) throw new Error(`时限无效：${value}，请使用 30m、2h 或 1d`)
  return Number(match[1]) * ({ m: 60_000, h: 3_600_000, d: 86_400_000 }[match[2]!]!)
}
// AttentionStore 没有 patch；复用同一文件锁与只追加格式，避免覆盖同时到达的人工回答。
async function patch(stores: ProjectStores, id: string, update: (item: AttentionItem) => AttentionItem): Promise<AttentionItem> {
  const file = attentionFile(stores.taktDir)
  return withFileLock(file, async () => {
    const item = (await stores.attention.list()).find(item => item.requestId === id)
    if (!item) throw new Error('待办不存在，请刷新后重试')
    const next = update(item)
    if (next !== item) await appendLine(file, JSON.stringify(next))
    return next
  })
}
export async function tickAttention(stores: ProjectStores, now: Date | string | number = new Date()): Promise<AttentionTickResult> {
  const date = new Date(now), at = date.toISOString()
  return withFileLock(join(stores.taktDir, 'attention-timebox'), async () => {
    const result: AttentionTickResult = { reminded: [], handedBack: [], resume: [], assumptions: [], stale: [] }
    for (let item of await stores.attention.list()) {
      if (item.kind === 'assumption') continue
      const reminder = timeboxMs(item.timebox?.remindAfter), handback = timeboxMs(item.timebox?.handbackAfter)
      const age = date.getTime() - Date.parse(item.createdAt)
      const events = await stores.events.read(item.runId, { types: ['human.reminded', 'human.handed_back'] })
      // 只提醒两次：第一次给接收人，第二次增加负责人，不无限重复轰炸。
      if (!item.answeredAt && reminder && age >= reminder) {
        const due = Math.min(2, Math.floor(age / reminder))
        for (let round = 1; round <= due; round++) {
          const to = [...new Set([...(item.assignees ?? []), ...(round > 1 ? [(await stores.workspaces.getRequirement(item.requirementId))?.owner ?? item.owner].filter((id): id is string => Boolean(id)) : [])])]
          item = await patch(stores, item.requestId, current => current.answeredAt || (current.remindedAt?.length ?? 0) >= round ? current
            : { ...current, remindedAt: [...(current.remindedAt ?? []), at] })
          if (item.answeredAt) break
          if (!events.some(event => { const data = event.data as { requestId: string; round?: number }; return event.type === 'human.reminded' && data.requestId === item.requestId && data.round === round })) {
            await stores.events.append(item.runId, { type: 'human.reminded', actor: system, nodeId: item.nodeId, data: { requestId: item.requestId, round, to } })
            result.reminded.push({ requestId: item.requestId, round, to })
          }
        }
      }
      if (!item.answeredAt && handback && age >= handback && item.form === 'answer' && item.assumption?.trim()) {
        item = await patch(stores, item.requestId, current => current.answeredAt ? current : {
          ...current, answeredAt: at, answeredBy: system, answer: current.assumption, handedBack: true,
        })
      }
      if (!item.handedBack) continue
      const run = await stores.runs.get(item.runId)
      if (run?.status === 'waiting_human' && !result.resume.includes(item.runId)) result.resume.push(item.runId)
      if (!events.some(event => event.type === 'human.handed_back' && (event.data as { requestId: string }).requestId === item.requestId)) {
        await stores.events.append(item.runId, { type: 'human.handed_back', actor: system, nodeId: item.nodeId, data: { requestId: item.requestId, assumption: item.assumption! } })
        result.handedBack.push(item)
      }
      await recordAnswerOnce(stores, item.runId, item)
      const requestId = `${item.requestId}:assumption`
      if (!(await stores.attention.list()).some(current => current.requestId === requestId)) result.assumptions.push(await stores.attention.create({
        requestId, runId: item.runId, nodeId: item.nodeId, requirementId: item.requirementId,
        kind: 'assumption', form: 'answer', ask: `按假设推进，待确认：${item.assumption}`, assumption: item.assumption,
        assumedFor: item.requestId, owner: item.owner, assignees: item.assignees,
      }))
    }
    result.stale = await reconcileAssumptions(stores)
    return result
  })
}
export async function reconcileAssumptions(stores: ProjectStores): Promise<Array<{ runId: string; nodeId: string }>> {
  return withFileLock(join(stores.taktDir, 'assumption-reconcile'), async () => {
    const file = join(stores.taktDir, 'assumption-reconciled.json')
    const handled = await readJsonFile<string[]>(file) ?? [], stale: Array<{ runId: string; nodeId: string }> = []
    for (const item of await stores.attention.list()) {
      if (item.kind !== 'assumption' || !item.answeredAt || handled.includes(item.requestId)) continue
      if (item.answeredBy?.type !== 'human') throw new Error('假设待办需要人工确认，请由负责人回答')
      await recordAnswerOnce(stores, item.runId, item)
      if (item.answer !== item.assumption) {
        const state = await stores.runs.get(item.runId)
        if (state?.nodes[item.nodeId]) {
          const reason = `人工改答假设：${item.answer ?? ''}`
          for (const output of state.nodes[item.nodeId]!.outputs) stale.push(...await markArtifactEdited(stores, { ...output, version: undefined }, item.answeredBy, reason))
          const latest = (await stores.runs.get(item.runId))!
          for (const nodeId of await rewindAffected(stores, latest, item.nodeId)) {
            latest.nodes[nodeId]!.status = 'stale'; stale.push({ runId: item.runId, nodeId })
          }
          if (latest.status === 'succeeded') { latest.status = 'failed'; delete latest.endedAt }
          await stores.runs.save(latest)
          await stores.events.append(item.runId, { type: 'log', actor: item.answeredBy, nodeId: item.nodeId, data: { level: 'info', message: `${reason}；依赖节点已过期，请恢复运行` } })
        }
      }
      handled.push(item.requestId)
      await writeFileAtomic(file, JSON.stringify(handled))
    }
    return [...new Map(stale.map(item => [`${item.runId}:${item.nodeId}`, item])).values()]
  })
}
