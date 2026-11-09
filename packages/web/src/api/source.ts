import type {
  ArtifactComment,
  ArtifactContent,
  ArtifactEditRequest,
  ArtifactEditResponse,
  ArtifactRecord,
  AttentionItem,
  ChatPostRequest,
  CommandInfo,
  CommandRunRequest,
  CommandRunResponse,
  LeadPresence,
  Lesson,
  LessonUpdateRequest,
  ReviewDisposition,
  ReviewDispositionRequest,
  RouteDecision,
  RoutePreviewRequest,
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
  DefectConfirmRequest,
  DefectDetail,
  DefectReportRequest,
  EvalCase,
  EvalCollectRequest,
  EvalRun,
  EvalRunRequest,
  NodeScorecard,
  Viewer,
} from '@taktflow/core'
import type { CrudSource, KnowledgeSource, StewardSource } from './source-m4'
import type { M5Source } from './source-m5'
import type { M6Source } from './source-m6'
import type { M8Source } from './source-m8'

export type { CrudSource, KnowledgeSource, StewardSource, StewardThreadDetail } from './source-m4'
export { RevisionConflictError, RewindConflictError, type M5Source } from './source-m5'
export { RuntimeConflictError, type M6Source } from './source-m6'
export { RoleConflictError, type M8Source } from './source-m8'

export type SpaceFileKind = SpaceFile['kind']

/**
 * PATCH /space/repos/:id 的修改项。JSON 会丢掉 undefined，服务端又是 `{ ...existing, ...input }` 合并，
 * 所以"清除"必须显式传 null（协议约定：null = 删除该键；见交付说明的协议变更请求）。
 */
export type RepoPatch = { [K in keyof Omit<RepoBinding, 'id'>]?: RepoBinding[K] | null }

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


export type ScorecardBy = NodeScorecard['key']['by']

/**
 * 评测输出快照（.takt/evals/runs/<run>/<case>/<variant>/ 下的文件）。
 * api.ts 还没有对应路由：建议 GET /api/eval/runs/:id/output?case=&variant=（见交付说明的协议变更请求）。
 */
export interface EvalOutputSnapshot {
  runId: string
  caseId: string
  variant: string
  outputDir?: string
  files: Array<{ path: string; content: string }>
}

/** Web 用到的全部数据接口：真实 HTTP 客户端和演示数据实现同一份。 */
export interface DataSource extends CrudSource, StewardSource, KnowledgeSource, M5Source, M6Source, M8Source {
  readonly mock: boolean
  /** 绑定到某个空间的数据源（空间内接口固定加该空间前缀，不看当前地址）：Solo 这类全局页按实体所在空间取数（docs/design/28 §2）。 */
  forSpace(spaceId: string): DataSource
  /** 当前用户（GET /me）：请求头 x-takt-user 指定，缺省为空间第一个 owner。 */
  me(): Promise<Viewer>
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
  harnesses(): Promise<HarnessInfo[]>
  models(): Promise<ModelInfo[]>
  /** 订阅运行的实时事件；返回取消订阅函数。 */
  subscribe(runId: string, onEvent: (e: EventEnvelope) => void): () => void

  // ---- 项目空间（docs/design/14）。除 spaces() 外都作用于当前 URL 的空间（/s/:spaceId）。
  /** archived 为 true 时只返回已归档的空间（全局接口，不加空间前缀）。 */
  spaces(opts?: { archived?: boolean }): Promise<SpaceSummary[]>
  space(): Promise<SpaceDetail>
  /** 空间写操作都要原因（服务端校验非空，写进审计）：成员走 body `{ members, reason }`，仓库放在 body.reason。 */
  setMembers(members: SpaceMember[], reason: string): Promise<SpaceDetail>
  addRepo(repo: RepoBinding, reason: string): Promise<SpaceDetail>
  /** 修改已绑定仓库的可变字段（bootstrap / share / defaultBranch 等）；值为 null 表示清除该字段。 */
  updateRepo(repoId: string, patch: RepoPatch, reason: string): Promise<SpaceDetail>
  syncRepo(repoId: string, reason: string): Promise<{ head: string }>
  spaceFile(kind: SpaceFileKind, name: string): Promise<SpaceFile>
  saveSpaceFile(kind: SpaceFileKind, name: string, body: { content: string; reason: string }): Promise<SpaceFile>

  // ---- 需求群聊（docs/design/15）
  room(requirementId: string): Promise<Room>
  addRoomMembers(requirementId: string, members: RoomMember[]): Promise<Room>
  chat(requirementId: string, opts?: { after?: number; limit?: number }): Promise<RoomMessage[]>
  postChat(requirementId: string, body: ChatPostRequest): Promise<RoomMessage>
  /**
   * 新消息实时到达（SSE）；同一个 id 再次到达表示消息被更新。
   * onLead：同一条 SSE 上的 `event: lead`（Lead 状态灯）；Room.lead 是订阅前的初始值。
   */
  subscribeChat(requirementId: string, onMessage: (m: RoomMessage) => void, onLead?: (p: LeadPresence) => void): () => void

  // ---- 评审（docs/design/18）
  requirementReviews(requirementId: string): Promise<ReviewSummary[]>
  /** 人对评审问题的处置（resolved / dismissed / open），reason 必填，进审计。 */
  disposeReview(runId: string, nodeId: string, body: ReviewDispositionRequest): Promise<ReviewDisposition>

  // ---- 外部参考改进（docs/design/19）
  /** 路由预览：只算路由卡，不启动运行；给 tier 表示改档（需要 reason）。 */
  routePreview(requirementId: string, body: RoutePreviewRequest): Promise<RouteDecision>
  /** ⌘K、Lead、CLI 共用的命令注册表。 */
  commands(): Promise<CommandInfo[]>
  /** 执行命令；write / dangerous 需要 reason。业务失败时 ok 为 false（不抛错）。 */
  runCommand(id: string, body: CommandRunRequest): Promise<CommandRunResponse>
  /** 经验库；status 不给时返回全部。 */
  lessons(status?: Lesson['status']): Promise<Lesson[]>
  /** 修改经验（启用 / 退役 / 改正文），reason 必填。 */
  updateLesson(id: string, body: LessonUpdateRequest): Promise<Lesson>

  // ---- 评测与归因（docs/design/20），作用于当前空间
  /** 成绩单：按节点 / 配方 / 技能聚合。 */
  scorecards(by: ScorecardBy, workflowId?: string): Promise<NodeScorecard[]>
  /** 评测用例；target 形如 node:<workflow>/<node> 或 skill:<name>，不给时返回全部。 */
  /** 默认不含已退役样本；样本页传 retired 一并取回。 */
  evalCases(target?: string, opts?: { retired?: boolean }): Promise<EvalCase[]>
  collectEvalCases(body: EvalCollectRequest): Promise<{ added: string[] }>
  /** 运行列表不含 results 明细（results 为空数组）。 */
  evalRuns(): Promise<EvalRun[]>
  evalRun(id: string): Promise<EvalRun>
  /** 后台执行，轮询 evalRun 看进度。 */
  startEvalRun(body: EvalRunRequest): Promise<EvalRun>
  /** 输出快照；后端路由待补（协议变更请求），HTTP 客户端在 404 时返回空 files。 */
  evalOutput(runId: string, caseId: string, variant: string): Promise<EvalOutputSnapshot>
  defects(requirementId: string): Promise<DefectDetail[]>
  reportDefect(requirementId: string, body: DefectReportRequest): Promise<DefectDetail>
  /** 预检 + 归因 Agent（后台执行，返回 attributing: true，轮询 defects 看结果）。 */
  attributeDefect(requirementId: string, defectId: string): Promise<DefectDetail>
  confirmDefect(requirementId: string, defectId: string, body: DefectConfirmRequest): Promise<DefectDetail>

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
