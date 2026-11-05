import type {
  ArtifactComment,
  ArtifactContent,
  ArtifactEditRequest,
  ArtifactEditResponse,
  ArtifactRecord,
  AttentionItem,
  ChatPostRequest,
  EventEnvelope,
  HarnessInfo,
  ModelInfo,
  NodeDetail,
  ProjectOverview,
  RequirementDetail,
  RequirementMetrics,
  RepoBinding,
  RequirementSummary,
  ReviewSummary,
  Room,
  RoomMember,
  RoomMessage,
  RunDetail,
  RunSummary,
  SpaceDetail,
  SpaceFile,
  SpaceMember,
  SpaceSummary,
  TraceGraph,
  WorkflowChangedEvent,
  WorkflowConflict,
  WorkflowDocument,
  WorkflowEditRequest,
  WorkflowLayout,
  WorkflowRevision,
  WorkflowSourceRequest,
  WorkflowSummary,
} from '@taktflow/core'

export type SpaceFileKind = SpaceFile['kind']

/** GET /api/workflows/:id/revisions/:rev 的响应；diff 是相对父修订的统一 diff（首个修订为空串）。 */
export interface WorkflowRevisionDetail {
  revision: WorkflowRevision
  source: string
  diff: string
}

/** PATCH / PUT source 返回 409：基线已变化且自动三方合并失败。两个数据源都抛这个错误。 */
export class WorkflowConflictError extends Error {
  constructor(readonly conflict: WorkflowConflict) {
    super('workflow 已被其他人修改，自动合并失败')
  }
}

/**
 * 门禁 Tab 要画 rubric 阈值线，阈值在 SnapshotNode.checks 里，但 NodeDetail 还没带检查定义（见交付说明里的协议变更请求）。
 * 在 server 补上之前按可选字段读：有就画阈值线，没有就只画分数。
 */
export type NodeView = NodeDetail

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
  node(runId: string, nodeId: string): Promise<NodeView>
  audit(runId: string): Promise<{ ok: boolean; brokenAt?: number }>
  attention(pending?: boolean): Promise<AttentionItem[]>
  answer(requestId: string, body: { decision?: string; answer?: string }): Promise<AttentionItem>
  harnesses(): Promise<HarnessInfo[]>
  models(): Promise<ModelInfo[]>
  /** 订阅运行的实时事件；返回取消订阅函数。 */
  subscribe(runId: string, onEvent: (e: EventEnvelope) => void): () => void

  // ---- 项目空间（docs/design/14）。除 spaces() 外都作用于当前 URL 的空间（/s/:spaceId）。
  spaces(): Promise<SpaceSummary[]>
  space(): Promise<SpaceDetail>
  setMembers(members: SpaceMember[]): Promise<SpaceDetail>
  addRepo(repo: RepoBinding): Promise<SpaceDetail>
  syncRepo(repoId: string): Promise<{ head: string }>
  spaceFile(kind: SpaceFileKind, name: string): Promise<SpaceFile>
  saveSpaceFile(kind: SpaceFileKind, name: string, body: { content: string; reason: string }): Promise<SpaceFile>

  // ---- 需求群聊（docs/design/15）
  room(requirementId: string): Promise<Room>
  addRoomMembers(requirementId: string, members: RoomMember[]): Promise<Room>
  chat(requirementId: string, opts?: { after?: number; limit?: number }): Promise<RoomMessage[]>
  postChat(requirementId: string, body: ChatPostRequest): Promise<RoomMessage>
  /** 新消息实时到达（SSE）；同一个 id 再次到达表示消息被更新。 */
  subscribeChat(requirementId: string, onMessage: (m: RoomMessage) => void): () => void

  // ---- 评审（docs/design/18）
  requirementReviews(requirementId: string): Promise<ReviewSummary[]>

  // ---- workflow 协同编辑（docs/design/16），作用于当前空间
  workflows(): Promise<WorkflowSummary[]>
  workflow(id: string): Promise<WorkflowDocument>
  /** 409 时抛 WorkflowConflictError。 */
  editWorkflow(id: string, body: WorkflowEditRequest): Promise<WorkflowDocument>
  /** 整文件替换；409 时抛 WorkflowConflictError。 */
  replaceWorkflowSource(id: string, body: WorkflowSourceRequest): Promise<WorkflowDocument>
  saveWorkflowLayout(id: string, layout: WorkflowLayout): Promise<WorkflowLayout>
  workflowRevisions(id: string): Promise<WorkflowRevision[]>
  workflowRevision(id: string, rev: string): Promise<WorkflowRevisionDetail>
  rollbackWorkflow(id: string, body: { rev: string; reason: string }): Promise<WorkflowDocument>
  /** workflow 文件被修改（人、Lead 或 Agent）时到达；包括自己的保存。 */
  subscribeWorkflow(id: string, onChange: (e: WorkflowChangedEvent) => void): () => void
}
