import type { ProjectStores } from '../interfaces.js'
import type { ArtifactRecord, ArtifactRef, EventEnvelope, EventType, RunState } from '../types.js'
import type { AttributionView, DefectView, InputSnapshot, Observation } from '../quality.js'
import type { CapturedInputSnapshot } from '../engine/capture-types.js'
import type { QualityStore } from '../store/quality-store.js'
import { getObject } from '../store/objects.js'
import { sha256 } from '../util/hash.js'

export type FrozenInput = InputSnapshot & Partial<Pick<CapturedInputSnapshot, 'results'>>
export type InvocationEvidence = EventEnvelope<'invocation.started'>['data'] & { inputSnapshot: FrozenInput; event: EventEnvelope<'invocation.started'> }
export type Point = { at: string; runId?: string; seq?: number }

export function qualityStore(stores: ProjectStores): QualityStore {
  if (!stores.quality) throw new Error('此项目未提供质量存储')
  return stores.quality
}

export function eventsOf<T extends EventType>(events: EventEnvelope[], type: T): EventEnvelope<T>[] {
  return events.filter((event): event is EventEnvelope<T> => event.type === type)
}

export const artifactKey = (ref: ArtifactRef): string => JSON.stringify([ref.workspace, ref.path, ref.version ?? null])
export const sameArtifact = (a: ArtifactRef, b: ArtifactRef): boolean => a.workspace === b.workspace && a.path === b.path
export const eventPoint = (event: EventEnvelope): Point => ({ at: event.ts, runId: event.runId, seq: event.seq })
export const eventLabel = (event: EventEnvelope): string => `${event.runId}:${event.seq} ${event.type}`

export function comparePoints(a: Point, b: Point): number {
  if (a.runId && a.runId === b.runId && a.seq !== undefined && b.seq !== undefined) return a.seq - b.seq
  return Date.parse(a.at) - Date.parse(b.at)
}

export function confirmedAttribution(defect: DefectView): AttributionView | undefined {
  const attribution = defect.attribution
  return attribution?.status === 'confirmed' && attribution.method === 'human' && attribution.by.type === 'human' ? attribution : undefined
}

export class QualityData {
  readonly invocations = new Map<string, InvocationEvidence>()
  private readonly artifacts = new Map<string, Promise<ArtifactRecord[]>>()

  private constructor(readonly stores: ProjectStores, readonly runs: RunState[], readonly events: EventEnvelope[]) {
    const finishes = new Map(eventsOf(events, 'invocation.finished').map((event) => [event.data.invocationId, event]))
    for (const event of eventsOf(events, 'invocation.started')) {
      const finish = finishes.get(event.data.invocation.invocationId)
      this.invocations.set(event.data.invocation.invocationId, { ...event.data, event,
        invocation: { ...event.data.invocation, ...(finish ? { outcome: finish.data.outcome, reported: finish.data.reported } : {}) } })
    }
  }

  static async read(stores: ProjectStores): Promise<QualityData> {
    const runs = await stores.runs.list()
    const events = (await Promise.all(runs.map((run) => stores.events.read(run.runId)))).flat()
    events.sort((a, b) => comparePoints(eventPoint(a), eventPoint(b)) || a.runId.localeCompare(b.runId))
    return new QualityData(stores, runs, events)
  }

  records(workspace: string): Promise<ArtifactRecord[]> {
    let records = this.artifacts.get(workspace)
    if (!records) { records = this.stores.workspaces.listArtifacts(workspace); this.artifacts.set(workspace, records) }
    return records
  }

  async version(ref: ArtifactRef) {
    const record = (await this.records(ref.workspace)).find((item) => item.path === ref.path)
    return { record, version: ref.version === undefined ? undefined : record?.versions.find((item) => item.version === ref.version) }
  }

  async text(ref: ArtifactRef): Promise<string | undefined> {
    if (ref.version === undefined) return undefined
    const { version } = await this.version(ref)
    if (!version) return undefined
    let content: Buffer | undefined
    try { content = await this.stores.workspaces.readArtifact(ref) } catch (error) {
      if (error instanceof Error && error.message.startsWith(`产物对象缺失：${version.sha256}（`)) return undefined
      throw error
    }
    if (!content) return undefined
    if (sha256(content) !== version.sha256) throw new Error(`归因材料 hash 不一致：${artifactKey(ref)}`)
    return content.includes(0) ? undefined : content.toString('utf8')
  }

  async object(hash: string): Promise<string | undefined> {
    try { return (await getObject(this.stores, hash)).toString('utf8') } catch (error) {
      // 历史材料缺失可显示 unknown；损坏、越界等完整性错误必须暴露。
      if (error instanceof Error && error.message === `对象缺失：${hash}`) return undefined
      throw error
    }
  }

  observationPoint(observation: Observation): Point {
    const result = ['found', 'still_open', 'verified_fixed'].includes(observation.kind)
      ? eventsOf(this.events, 'review.result').find((event) => event.data.checkpointId === observation.checkpointId) : undefined
    return result ? eventPoint(result) : { at: observation.at, runId: observation.runId }
  }

  reviewedArtifacts(observations: Observation[]): ArtifactRef[] {
    const refs: ArtifactRef[] = []
    for (const observation of observations) {
      const subject = observation.subject.artifact
      if (subject?.version !== undefined) { refs.push(subject); continue }
      const checkpoint = eventsOf(this.events, 'checkpoint.scheduled').find((event) => event.data.checkpointId === observation.checkpointId)
      const result = eventsOf(this.events, 'review.result').find((event) => event.data.checkpointId === observation.checkpointId)
      const call = observation.invocationId ? this.invocations.get(observation.invocationId) : undefined
      const frozen = checkpoint?.data.materials.filter((item) => item.role === 'target').map((item) => item.ref)
        ?? result?.data.record.artifacts ?? call?.inputSnapshot.inputs.filter((item) => item.role === 'target').map((item) => item.ref) ?? []
      const matched = frozen.filter((ref) => !subject || sameArtifact(ref, subject))
      refs.push(...(matched.length ? matched : subject ? [subject] : []))
    }
    return [...new Map(refs.map((ref) => [artifactKey(ref), ref])).values()]
  }
}

export async function defectContext(stores: ProjectStores, defectId: string) {
  const quality = qualityStore(stores)
  const defect = await quality.defect(defectId)
  if (!defect) throw new Error(`缺陷不存在：${defectId}`)
  const [data, observations] = await Promise.all([QualityData.read(stores), quality.observations({ requirement: defect.requirementId })])
  const linked = observations.filter((item) => defect.observations.includes(item.id))
  return { data, defect, observations, linked, query: [defect.title, ...linked.map((item) => item.text)].join('\n') }
}

export function discovery(data: QualityData, linked: Observation[]): Observation | undefined {
  return linked.filter((item) => item.kind === 'found' || item.kind === 'still_open')
    .sort((a, b) => comparePoints(data.observationPoint(a), data.observationPoint(b)))[0]
}
