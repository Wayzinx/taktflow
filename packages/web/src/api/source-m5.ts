import type {
  RoomMessage,
  ArtifactContent,
  DefectDetail,
  DefectMergeSuggestion,
  DefectUpdateRequest,
  EvalCase,
  EvalSampleRequest,
  MissDecisionRequest,
  NodeChanges,
  Observation,
  QualityStatus,
  RewindPreview,
  RewindRequest,
  RewindResult,
  RunTimeline,
  SnapshotManifest,
  StewardDelegation,
} from '@taktflow/core'

/** 回退执行时 token 与当前状态不符（409）：预览之后状态变了，需要重新预览。 */
export class RewindConflictError extends Error {
  constructor(message = '预览之后状态变了') {
    super(message)
  }
}

/** 缺陷编辑时 baseRevision 不一致（409）：别人刚改过。 */
export class RevisionConflictError extends Error {
  constructor(message = '别人刚改过这条缺陷') {
    super(message)
  }
}

/** M5 接口：运行透明与回退（docs/design/26）、归因可信度（docs/design/21）。路由见 packages/core/src/api.ts 顶部的接口表。 */
export interface M5Source {
  // ---- 运行透明与回退
  timeline(runId: string): Promise<RunTimeline>
  nodeChanges(runId: string, nodeId: string): Promise<NodeChanges>
  /** 统一 diff；不给 path 为整个节点。 */
  nodeDiff(runId: string, nodeId: string, path?: string): Promise<{ patch: string }>
  rewindPreview(runId: string, nodeId: string): Promise<RewindPreview>
  /** token 不符时抛 RewindConflictError。 */
  rewind(runId: string, nodeId: string, body: RewindRequest): Promise<RewindResult>
  /** 管家转达重发：只允许 uncertain / expired。 */
  resendDelegation(messageId: string, reason: string): Promise<StewardDelegation>
  /** 群聊任务卡重发：只允许 receipt 为 uncertain / expired；返回新的 task 消息。 */
  resendRoomTask(requirementId: string, messageId: string, reason: string): Promise<RoomMessage>

  // ---- 归因可信度
  snapshot(runId: string, checkpointId: string): Promise<SnapshotManifest>
  snapshotFile(runId: string, checkpointId: string, path: string): Promise<ArtifactContent>
  observations(requirementId: string, opts?: { source?: string; run?: string }): Promise<Observation[]>
  /** baseRevision 不一致时抛 RevisionConflictError。 */
  updateDefect(requirementId: string, defectId: string, body: DefectUpdateRequest): Promise<DefectDetail>
  mergeSuggestions(requirementId: string): Promise<DefectMergeSuggestion[]>
  decideMerge(requirementId: string, suggestionId: string, body: { decision: 'accept' | 'reject' | 'undo'; reason: string }): Promise<DefectMergeSuggestion>
  decideMiss(requirementId: string, defectId: string, checkpointId: string, body: MissDecisionRequest): Promise<DefectDetail>
  createEvalSample(body: EvalSampleRequest): Promise<EvalCase>
  retireEvalSample(caseId: string, reason: string): Promise<EvalCase>
  qualityStatus(): Promise<QualityStatus>
  syncQuality(body: { runId?: string; reason: string }): Promise<QualityStatus>
  repairQuality(reason: string): Promise<QualityStatus>
}
