import type { EventStore, EventVerifyReason } from '../interfaces.js'
import type { Actor, EventEnvelope } from '../types.js'
import type { Candidate, DefectView, EvalCaseView, EvalReportView, Observation, QualityEventPayloads, QualityEventType } from '../quality.js'

export type QualityEventInput = { [T in QualityEventType]: { type: T; actor: Actor; data: QualityEventPayloads[T] } }[QualityEventType]
export type QualityEventEnvelope = QualityEventInput & {
  seq: number
  ts: string
  idempotencyKey: string
  commitId: string
  commitIndex: number
  commitSize: number
  prevHash: string
  hash: string
}

/** revision 键为 defect:<id> / evalcase:<id> / eval:<id>；不存在时为 0。 */
export interface QualityAppendOptions {
  baseRevisions?: Record<string, number>
  /** 与 events 一一对应；observation.recorded 必须使用 observation.id。 */
  idempotencyKeys: string[]
}
export interface QualityCommit {
  /** 包含幂等命中的原事件，顺序与输入相同。 */
  events: QualityEventEnvelope[]
  appended: number
  /** 空间日志水位，与各实体的 revision 分开。 */
  revision: number
  revisions: Record<string, number>
}
export interface QualityBatch extends QualityAppendOptions { events: QualityEventInput[] }
export interface QualityVerifyResult { ok: boolean; brokenAt?: number; reason?: EventVerifyReason }
export type QualityCursor = QualityEventPayloads['cursor.advanced']
export type QualityCursorKey = Omit<QualityCursor, 'seq'>
export type CandidateInput = Omit<Candidate, 'candidateId' | 'createdAt'> & { createdAt?: string }

export interface QualityStore {
  append(events: QualityEventInput[], options: QualityAppendOptions): Promise<QualityCommit>
  read(options?: { afterSeq?: number; types?: QualityEventType[] }): Promise<QualityEventEnvelope[]>
  verify(): Promise<QualityVerifyResult>
  repair(reason?: string): Promise<QualityCommit>
  rebuild(): Promise<void>
  defects(filter?: { id?: string; requirement?: string; status?: DefectView['validity'] | DefectView['resolution'] }): Promise<DefectView[]>
  defect(id: string): Promise<DefectView | undefined>
  observations(filter?: { requirement?: string; run?: string; issueKey?: string }): Promise<Observation[]>
  evalcases(filter?: { status?: EvalCaseView['status'] }): Promise<EvalCaseView[]>
  candidates(): Promise<Candidate[]>
  evals(): Promise<EvalReportView[]>
  eval(evalId: string): Promise<EvalReportView | undefined>
  createCandidate(input: CandidateInput): Promise<Candidate>
  getCursor(key: QualityCursorKey): Promise<number>
  /** 把处理结果和游标事件放进同一提交；锚点成功后才物化 cursors.json。 */
  advanceCursor(cursor: QualityCursor, batch: QualityBatch): Promise<QualityCommit>
  replayFromCursor(events: EventStore, key: QualityCursorKey,
    process: (event: EventEnvelope) => Promise<QualityBatch>): Promise<number>
}

// 在存储负责范围内声明纯增量；旧宿主和测试的 ProjectStores 不必补 quality。
declare module '../interfaces.js' {
  interface ProjectStores { quality?: QualityStore }
}

export class QualityRevisionConflict extends Error {
  readonly code = 'QUALITY_REVISION_CONFLICT'
  constructor(readonly key: string, readonly expected: number, readonly actual: number) {
    super(`质量 revision 冲突：${key}，baseRevision=${expected}，当前=${actual}`)
    this.name = 'QualityRevisionConflict'
  }
}
