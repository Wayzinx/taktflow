import { attributionCandidates } from '@taktflow/core'
import type { CheckpointRef, EventPayloads, ProjectStores, QualityStore } from '@taktflow/core'
import { ApiError } from './errors.js'
import { oneOf } from './quality-validation.js'
import { runId, safeId, text } from './validation.js'

export type QualityReadOp = 'quality.defects' | 'quality.defect' | 'quality.observations' | 'quality.invocation'
  | 'quality.checkpoint' | 'quality.attribution.candidates' | 'quality.evalcases' | 'quality.candidates' | 'quality.evals' | 'quality.eval'

export const VALIDITIES = ['unconfirmed', 'valid', 'not_a_defect', 'duplicate'] as const
export const RESOLUTIONS = ['open', 'claimed_fixed', 'verified_fixed', 'accepted_risk', 'reopened'] as const
export const CASE_STATUSES = ['proposed', 'active', 'retired'] as const

export function qualityStore(stores: ProjectStores): QualityStore {
  if (!stores.quality) throw new ApiError(501, '当前宿主未接入质量存储')
  return stores.quality
}

export async function qualityDefect(stores: ProjectStores, id: string) {
  const item = await qualityStore(stores).defect(id)
  if (!item) throw new ApiError(404, `缺陷不存在：${id}`)
  return item
}

async function sourceEvents(stores: ProjectStores, id: string) {
  const run = runId(id.split(':')[0]!)
  if (!await stores.runs.get(run)) throw new ApiError(404, `运行不存在：${run}`)
  const verified = await stores.events.verify(run)
  if (!verified.ok) throw new Error(`源运行日志校验失败：${run}`)
  return stores.events.read(run)
}

export async function qualityInvocation(stores: ProjectStores, id: string): Promise<EventPayloads['invocation.started']> {
  const events = await sourceEvents(stores, id)
  const start = events.find((event) => event.type === 'invocation.started' && (event.data as EventPayloads['invocation.started']).invocation.invocationId === id)
  if (!start) throw new ApiError(404, `调用不存在：${id}`)
  const data = structuredClone(start.data as EventPayloads['invocation.started'])
  for (const event of events) if (event.type === 'invocation.finished') {
    const finish = event.data as EventPayloads['invocation.finished']
    if (finish.invocationId === id) {
      Object.assign(data.invocation, { outcome: finish.outcome, reported: finish.reported })
      const replay = (finish as typeof finish & { replay?: string }).replay
      if (replay === 'full' || replay === 'limited' || replay === 'none') data.invocation.replay = replay
    }
  }
  return data
}

export async function qualityCheckpoint(stores: ProjectStores, id: string): Promise<CheckpointRef> {
  const events = await sourceEvents(stores, id)
  const scheduled = events.find((event) => event.type === 'checkpoint.scheduled' && (event.data as CheckpointRef).checkpointId === id)
  if (!scheduled) throw new ApiError(404, `检查点不存在：${id}`)
  const checkpoint = structuredClone(scheduled.data as CheckpointRef)
  const calls = new Set<string>()
  for (const event of events) {
    if (event.type === 'invocation.started') {
      const { invocation } = event.data as EventPayloads['invocation.started']
      if (invocation.checkpointId === id) { calls.add(invocation.invocationId); checkpoint.invocationId = invocation.invocationId; checkpoint.status = 'scheduled' }
    } else if (event.type === 'invocation.finished') {
      const finish = event.data as EventPayloads['invocation.finished']
      if (calls.has(finish.invocationId) && finish.outcome.status !== 'ok') checkpoint.status = 'error'
    } else if (event.type === 'review.result') {
      const result = event.data as EventPayloads['review.result']
      if (result.checkpointId === id) { checkpoint.status = 'completed'; checkpoint.invocationId = result.invocationId ?? result.record.invocationId }
    }
  }
  return checkpoint
}

export async function readQuality(stores: ProjectStores, op: QualityReadOp, params: Record<string, string | undefined>): Promise<unknown> {
  const quality = qualityStore(stores)
  switch (op) {
    case 'quality.defects': return quality.defects({ id: params.id, requirement: params.requirement === undefined ? undefined : safeId(params.requirement),
      status: params.status === undefined ? undefined : oneOf(params.status, [...VALIDITIES, ...RESOLUTIONS], 'status') })
    case 'quality.defect': return qualityDefect(stores, text(params.id, 'id'))
    case 'quality.observations': return quality.observations({ requirement: safeId(text(params.requirement, 'requirement')), run: params.run === undefined ? undefined : runId(params.run), issueKey: params.issueKey })
    case 'quality.invocation': return qualityInvocation(stores, text(params.invocationId, 'invocationId'))
    case 'quality.checkpoint': return qualityCheckpoint(stores, text(params.checkpointId, 'checkpointId'))
    case 'quality.attribution.candidates': {
      const id = text(params.defectId, 'defectId')
      await qualityDefect(stores, id)
      return attributionCandidates(stores, id)
    }
    case 'quality.evalcases': return quality.evalcases({ status: params.status === undefined ? undefined : oneOf(params.status, CASE_STATUSES, 'status') })
    case 'quality.candidates': return quality.candidates()
    case 'quality.evals': return quality.evals()
    case 'quality.eval': {
      const item = await quality.eval(text(params.evalId, 'evalId'))
      if (!item) throw new ApiError(404, '评测不存在')
      return item
    }
  }
}
