import type {
  ArtifactComment,
  ArtifactContent,
  ArtifactEditRequest,
  ArtifactEditResponse,
  ArtifactRecord,
  AttentionItem,
  EventEnvelope,
  NodeDetail,
  ProjectOverview,
  RequirementDetail,
  RequirementMetrics,
  RequirementSummary,
  RunDetail,
  RunSummary,
  TraceGraph,
} from '@taktflow/core'

/** Web 用到的全部数据接口：真实 HTTP 客户端和演示数据实现同一份。 */
export interface DataSource {
  readonly mock: boolean
  project(): Promise<ProjectOverview>
  requirements(): Promise<RequirementSummary[]>
  requirement(id: string): Promise<RequirementDetail>
  artifacts(id: string): Promise<ArtifactRecord[]>
  artifact(id: string, path: string, version?: number): Promise<ArtifactContent>
  editArtifact(id: string, path: string, body: ArtifactEditRequest): Promise<ArtifactEditResponse>
  comments(id: string, path?: string): Promise<ArtifactComment[]>
  addComment(id: string, body: { path: string; version: number; body: string }): Promise<ArtifactComment>
  trace(id: string): Promise<TraceGraph>
  metrics(id: string): Promise<RequirementMetrics>
  runs(requirementId?: string): Promise<RunSummary[]>
  run(runId: string): Promise<RunDetail>
  events(runId: string, opts?: { after?: number; node?: string }): Promise<EventEnvelope[]>
  node(runId: string, nodeId: string): Promise<NodeDetail>
  audit(runId: string): Promise<{ ok: boolean; brokenAt?: number }>
  attention(pending?: boolean): Promise<AttentionItem[]>
  answer(requestId: string, body: { decision?: string; answer?: string }): Promise<AttentionItem>
  /** 订阅运行的实时事件；返回取消订阅函数。 */
  subscribe(runId: string, onEvent: (e: EventEnvelope) => void): () => void
}
