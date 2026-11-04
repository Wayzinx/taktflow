/**
 * 存储与引擎的接口。实现放在 store/、engine/ 下；server 和 cli 只依赖这些接口。
 *
 * 存储是"文件优先"的：所有状态都在被管理项目的 `.takt/` 目录里，人和 agent 都能直接读，
 * git 友好，可以随项目一起审阅。布局见 docs/design/06-追溯与审计.md。
 */
import type {
  Actor,
  ArtifactComment,
  ArtifactKind,
  ArtifactRecord,
  ArtifactRef,
  CompactionRecord,
  ContextSnapshot,
  EventEnvelope,
  EventPayloads,
  EventType,
  HarnessAdapter,
  AgentProfile,
  KnowledgeSource,
  NodeId,
  Requirement,
  RequirementId,
  RequirementMetrics,
  RunId,
  RunState,
  TaktConfig,
  TraceGraph,
  WorkflowDefinition,
  WorkflowSnapshot,
} from './types.js'

/** 公共存放区：每个需求一个目录，产物带版本、溯源和评论。 */
export interface WorkspaceStore {
  listRequirements(): Promise<Requirement[]>
  getRequirement(id: RequirementId): Promise<Requirement | undefined>
  createRequirement(input: { id?: RequirementId; title: string; links?: Requirement['links']; owner?: string }): Promise<Requirement>
  updateRequirement(id: RequirementId, patch: Partial<Omit<Requirement, 'id' | 'createdAt'>>): Promise<Requirement>
  /** 公共存放区在磁盘上的绝对路径。 */
  dir(id: RequirementId): string

  listArtifacts(id: RequirementId): Promise<ArtifactRecord[]>
  readArtifact(ref: ArtifactRef): Promise<Buffer | undefined>
  /**
   * 写入一个新版本（内容寻址去重）。同内容重复写入返回已有版本，不产生新版本。
   * 人工修改必须给 reason。
   */
  writeArtifact(input: {
    ref: Omit<ArtifactRef, 'version'>
    content: Buffer | string
    kind: ArtifactKind
    author: Actor
    reason?: string
    derivedFrom?: ArtifactRef[]
    producedBy?: { runId: RunId; nodeId: NodeId }
    title?: string
    tags?: string[]
  }): Promise<ArtifactRef & { version: number }>
  /** 扫描磁盘，找出绕过引擎直接改动的文件（sha 与清单不一致），用于审计。 */
  detectUntracked(id: RequirementId): Promise<Array<{ path: string; sha256: string }>>

  listComments(id: RequirementId, path?: string): Promise<ArtifactComment[]>
  addComment(id: RequirementId, comment: Omit<ArtifactComment, 'id' | 'createdAt'>): Promise<ArtifactComment>
}

/** 事件日志：只追加、哈希链。 */
export interface EventStore {
  append<T extends EventType>(runId: RunId, e: { type: T; actor: Actor; nodeId?: NodeId; data: EventPayloads[T] }): Promise<EventEnvelope<T>>
  read(runId: RunId, opts?: { afterSeq?: number; nodeId?: NodeId; types?: EventType[] }): Promise<EventEnvelope[]>
  /** 实时订阅（server 的 SSE 用）。返回取消订阅函数。 */
  subscribe(runId: RunId, onEvent: (e: EventEnvelope) => void): () => void
  /** 校验哈希链；返回第一处断链的 seq。 */
  verify(runId: RunId): Promise<{ ok: boolean; brokenAt?: number }>
}

export interface RunStore {
  /** 创建运行时同时保存 workflow 快照（runs/<id>/workflow.json）。 */
  create(state: RunState, workflow: WorkflowSnapshot): Promise<void>
  getWorkflow(runId: RunId): Promise<WorkflowSnapshot | undefined>
  save(state: RunState): Promise<void>
  get(runId: RunId): Promise<RunState | undefined>
  list(filter?: { requirementId?: RequirementId }): Promise<RunState[]>
  saveContext(runId: RunId, snapshot: ContextSnapshot): Promise<void>
  saveCompaction(runId: RunId, record: CompactionRecord): Promise<void>
  getContext(runId: RunId, nodeId: NodeId): Promise<{ snapshots: ContextSnapshot[]; compactions: CompactionRecord[] }>
}

/** 待人处理的事项（审批、回答问题、判决交人）。 */
export interface AttentionItem {
  requestId: string
  runId: RunId
  nodeId: NodeId
  requirementId: RequirementId
  ask: string
  form: 'approve' | 'answer' | 'choice'
  choices?: string[]
  createdAt: string
  answeredAt?: string
  decision?: string
  answer?: string
}

export interface AttentionStore {
  list(filter?: { pending?: boolean; requirementId?: RequirementId }): Promise<AttentionItem[]>
  create(item: Omit<AttentionItem, 'createdAt'>): Promise<AttentionItem>
  answer(requestId: string, input: { decision?: string; answer?: string; by: Actor }): Promise<AttentionItem>
}

/** 一个项目的全部存储。 */
export interface ProjectStores {
  projectDir: string
  /** `.takt/` 的绝对路径。 */
  taktDir: string
  config: TaktConfig
  workspaces: WorkspaceStore
  events: EventStore
  runs: RunStore
  attention: AttentionStore
}

export interface EngineDeps {
  stores: ProjectStores
  harnesses: Record<string, HarnessAdapter>
  profiles: Record<string, AgentProfile>
  knowledge: KnowledgeSource[]
}

export interface StartRunInput {
  workflow: WorkflowDefinition
  requirementId: RequirementId
  args?: Record<string, unknown>
}

/**
 * 引擎：按 DAG 调度节点。
 * - 依赖满足即调度，同层并发（受 concurrency 限制）；
 * - 每个节点结束后：收集声明产物 → 记版本与溯源 → 写守卫检查 → 落 state → 发事件；
 * - human 节点和 gate onFail=human 让运行进入 waiting_human，answer 后 resume 继续；
 * - resume 时已成功的节点直接复用结果，从未完成的节点继续（与 spec-kit 的 execution tree 思路一致）。
 */
export interface Engine {
  start(input: StartRunInput): Promise<RunState>
  resume(runId: RunId, workflow: WorkflowDefinition): Promise<RunState>
  cancel(runId: RunId): Promise<void>
  /** 公共存放区产物被人改了：把读过它的节点及其下游标记为 stale。 */
  markStale(runId: RunId, cause: ArtifactRef): Promise<NodeId[]>
}

/** 读模型：给 server / web 用的聚合查询（全部从文件计算）。 */
export interface Insights {
  traceGraph(requirementId: RequirementId): Promise<TraceGraph>
  metrics(requirementId: RequirementId): Promise<RequirementMetrics>
}
