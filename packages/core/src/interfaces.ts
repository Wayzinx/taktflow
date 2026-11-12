/**
 * 存储与引擎的接口。实现放在 store/、engine/ 下；server 和 cli 只依赖这些接口。
 *
 * 存储是"文件优先"的：所有状态都在被管理项目的 `.takt/` 目录里，人和 agent 都能直接读，
 * git 友好，可以随项目一起审阅。布局见 docs/design/06-追溯与审计.md。
 */
import type {
  ProviderBridge,
  EvalCase,
  EvalRun,
  Actor,
  Defect,
  DefectAttribution,
  DefectMergeSuggestion,
  HumanTimebox,
  Observation,
  QualityLogEntry,
  QualityLogKind,
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
  KnowledgeBase,
  KnowledgeBinding,
  KnowledgeBuild,
  KnowledgeEvalCase,
  KnowledgeEvalRun,
  KnowledgeEvalVariant,
  KnowledgeHit,
  KnowledgeIntent,
  KnowledgeQuery,
  KnowledgeRetrieval,
  KnowledgeSource,
  Lesson,
  NodeId,
  Requirement,
  RequirementId,
  RequirementMetrics,
  RepoBinding,
  Room,
  RoomMember,
  RoomMessage,
  RouteDecision,
  RunBudget,
  RunId,
  RunState,
  SandboxProvider,
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
    /** invocationId：哪一次 harness 调用写的（docs/design/21 §2），与 ArtifactVersion.producedBy 一致。 */
    producedBy?: { runId: RunId; nodeId: NodeId; invocationId?: string }
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
  /** 校验哈希链；返回第一处断链的 seq。reason：压缩过的日志归档缺失 / 被改动等，说明为什么不完整。 */
  verify(runId: RunId): Promise<{ ok: boolean; brokenAt?: number; reason?: string }>
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

/**
 * 待人处理的事项（审批、回答问题、判决交人）。
 * requestId 规则：首次为 `${runId}:${nodeId}`；同一节点在 loop 后续轮次或重复请求时追加 `#<序号>`（从 2 开始），
 * 避免上一轮的批准被复用。
 */
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
  /** 谁回答的（审计用）。 */
  answeredBy?: Actor
  /**
   * 回答编码：approve → decision 为 'approve' | 'reject'，answer 为可选备注；
   * choice → decision 为 'choice'，answer 为所选项原文；answer → 无 decision，answer 为回答文本。
   */
  decision?: string
  answer?: string
  /**
   * 待办类别：缺省为节点的审批 / 回答；其余由引擎在预算、重复失败、路由改档时产生。
   * assumption：无人回答时按假设推进了，等人确认或改答（docs/design/26 §3）；不阻塞运行。
   */
  kind?: 'node' | 'budget' | 'retry' | 'route' | 'workflow_change' | 'assumption'
  /** 审批对象的产物版本；产物之后有新版本时 stale 为 true（由读模型计算）。 */
  boundTo?: ArtifactRef[]
  stale?: boolean
  /** 节点 owner（职责标签）与据此派给的空间成员 id。 */
  owner?: string
  assignees?: string[]
  /** 等人限时（docs/design/26 §3）：生效的时限、提醒记录、是否已按假设交还。 */
  timebox?: HumanTimebox
  assumption?: string
  remindedAt?: string[]
  handedBack?: boolean
  /** kind 为 assumption 时：被按假设作答的原待办。 */
  assumedFor?: string
}

export interface AttentionStore {
  list(filter?: { pending?: boolean; requirementId?: RequirementId }): Promise<AttentionItem[]>
  create(item: Omit<AttentionItem, 'createdAt'>): Promise<AttentionItem>
  /** boundTo：回答时看到的产物版本（审批绑定版本，docs/design/19）。 */
  answer(requestId: string, input: { decision?: string; answer?: string; by: Actor; boundTo?: ArtifactRef[] }): Promise<AttentionItem>
}

/** 一个项目的全部存储。 */
/** 需求群聊：每个需求一个房间，消息只追加（.takt/chat/<REQ>.jsonl）。 */
export interface ChatStore {
  getRoom(requirementId: RequirementId): Promise<Room | undefined>
  /** 需求创建时调用：建房间，默认成员为需求负责人 + Lead。已存在则返回现有房间。 */
  ensureRoom(requirementId: RequirementId, input?: { title?: string; members?: RoomMember[] }): Promise<Room>
  addMembers(requirementId: RequirementId, members: RoomMember[]): Promise<Room>
  list(requirementId: RequirementId, opts?: { afterSeq?: number; limit?: number }): Promise<RoomMessage[]>
  post(requirementId: RequirementId, message: Omit<RoomMessage, 'id' | 'roomId' | 'seq' | 'at'>): Promise<RoomMessage>
  /** 实时订阅（跨进程轮询 tail，与 EventStore 一致）。 */
  subscribe(requirementId: RequirementId, onMessage: (m: RoomMessage) => void): () => void
}

/** 外部 IM 适配（飞书 / Slack …）：消息双向同步，审计以 taktflow 侧为准。 */
export interface ChatBridge {
  id: string
  createRoom(room: Room): Promise<{ chatId: string }>
  invite(room: Room, members: RoomMember[]): Promise<void>
  post(room: Room, message: RoomMessage): Promise<void>
  onMessage(handler: (chatId: string, message: Omit<RoomMessage, 'id' | 'roomId' | 'seq' | 'at'>) => void): () => void
}

/** 代码仓库：镜像 + 每个任务一个 worktree（docs/design/17）。 */
export interface RepoManager {
  list(): RepoBinding[]
  /** 确保本地镜像存在且是最新（有 url 时 fetch）。 */
  sync(repoId: string): Promise<{ head: string }>
  /**
   * 建 worktree 后按 RepoBinding.share 软链共享目录、执行 bootstrap；引导失败时抛错（错误信息带输出末尾），
   * 调用方据此把节点置为 blocked。
   */
  createWorktree(input: { repoId: string; runId: RunId; nodeId: NodeId; base?: string; /** 从 base 开出后依次合并的提交（依赖多个上游任务时）；冲突时抛错且不留下 worktree。 */ merge?: string[] }): Promise<{ path: string; branch: string; base: string; bootstrap?: { command?: string; shared: string[]; ok: boolean; ms: number; output?: string } }>
  /** worktree 相对 base 的改动（统一 diff 文本 + 改动文件列表）。 */
  diff(worktreePath: string, base: string): Promise<{ patch: string; files: string[] }>
  removeWorktree(worktreePath: string): Promise<void>
  /** 把 worktree 里未提交的改动（不含同步的技能和共享目录）提交到它的分支，返回 HEAD；没有改动时返回原 HEAD。 */
  commit?(worktreePath: string, message: string): Promise<string>
}

/** 一个项目空间的全部存储。 */
export interface ProjectStores {
  projectDir: string
  /** `.takt/` 的绝对路径。 */
  taktDir: string
  config: TaktConfig
  /** 解析后的目录约定（新空间为顶层目录，旧项目为 .takt/ 下的目录）。 */
  paths: { agents: string; workflows: string; skills: string; knowledge: string; requirements: string; evals?: string }
  workspaces: WorkspaceStore
  events: EventStore
  runs: RunStore
  attention: AttentionStore
  chat: ChatStore
  /** 经验库（knowledge/lessons/*.md）；未启用时不传。 */
  lessons?: LessonStore
  /** 知识库（docs/design/23）；未接入时不传，引擎退回旧知识源。 */
  kb?: KnowledgeStore
  /** 质量日志与读模型（docs/design/21 §7）；未接入时缺陷沿用 M3 的存放区文件。 */
  quality?: QualityStore
}

/**
 * 质量日志：.takt/quality/log.jsonl 是唯一权威记录（哈希链 + 锚点），缺陷 / 归因 / 样本 / 评测是可重建的读模型（.takt/quality/views/）。
 * 写入在同一把提交锁里完成：查重（幂等键）→ 检查 baseRevision → 追加 → 更新锚点。人工结论不会被自动结果覆盖。
 */
export interface QualityStore {
  /**
   * 追加；同 key 已存在的跳过。baseRevision 不一致时抛 QualityConflictError（server 映射为 409）。
   * 缺陷按 revision 序号比较；样本 / 评测按对象内容哈希（canonicalJson 后 sha256）比较，在同一提交锁内检查。
   */
  append(
    entries: Array<{ kind: QualityLogKind; key: string; requirementId?: RequirementId; data: unknown; actor: Actor }>,
    options?: { baseRevision?: { defectId: string; revision: number } | { objectKind: 'sample' | 'evaluation'; objectId: string; revision: string } },
  ): Promise<{ appended: QualityLogEntry[]; skipped: string[] }>
  /** 从运行事件入账观察：从游标继续，提交成功才推进游标；不传 runId 则处理全部运行。 */
  sync(runId?: RunId): Promise<{ observations: number; runs: number }>
  observations(filter?: { requirementId?: RequirementId; source?: Observation['source']; runId?: RunId }): Promise<Observation[]>
  defects(requirementId?: RequirementId): Promise<Array<Defect & { attribution?: DefectAttribution }>>
  mergeSuggestions(requirementId?: RequirementId): Promise<DefectMergeSuggestion[]>
  /** 评测样本（含已退役，看 sample.retiredAt）与评测运行，均从日志重建。 */
  samples(): Promise<EvalCase[]>
  evaluations(): Promise<EvalRun[]>
  /** 链与锚点校验；anchorBehind：链完整但锚点落后（可 repair）。 */
  status(): Promise<QualityStatus>
  /** 只补锚点并记 recovery；链被篡改或截断时拒绝（抛错，交给人）。 */
  repair(by: Actor, reason: string): Promise<QualityStatus>
  /** 删除并从日志重建读模型。 */
  rebuild(): Promise<void>
}

export interface QualityStatus {
  ok: boolean
  entries: number
  anchor?: { seq: number; hash: string }
  anchorBehind?: boolean
  brokenAt?: number
  /** 每个运行已入账到的事件序号。 */
  cursors: Record<RunId, number>
  lastSyncAt?: string
  /** M3 存放区缺陷是否已导入。 */
  importedM3?: boolean
}

/** 经验库存储：每条经验一个带 frontmatter 的 Markdown 文件，修改记 space-events。 */
export interface LessonStore {
  list(filter?: { status?: Lesson['status'] }): Promise<Lesson[]>
  get(id: string): Promise<Lesson | undefined>
  /** 新建或更新（按 id）；返回写入后的经验。 */
  upsert(lesson: Omit<Lesson, 'createdAt' | 'updatedAt'> & { createdAt?: string }, by: Actor, reason: string): Promise<Lesson>
  setStatus(id: string, status: Lesson['status'], by: Actor, reason: string): Promise<Lesson>
}

/** 引擎在 agent 节点开始 / 结束时调用的经验挂点（实现见 core/lessons）。 */
export interface LessonRecall {
  /** 按触发条件召回；holdout 为 true 时本次不注入（对照组），但仍返回命中的 id 用于统计。 */
  recall(input: { runId: RunId; nodeId: NodeId; role?: string; paths: string[]; feedback?: string }): Promise<{ lessons: Lesson[]; holdout: boolean; text: string; tokens: number }>
  /** 节点结束：首次执行成功记帮助，失败记坑（对照组不记坑）；达到阈值时改状态并返回变化。 */
  record(input: { runId: RunId; nodeId: NodeId; ids: string[]; holdout: boolean; outcome: 'helped' | 'hurt' }): Promise<Array<{ id: string; status: Lesson['status']; reason: string; stats: Lesson['stats'] }>>
}

export interface EngineDeps {
  stores: ProjectStores
  harnesses: Record<string, HarnessAdapter>
  profiles: Record<string, AgentProfile>
  knowledge: KnowledgeSource[]
  /** 不传时用 local（不隔离）。 */
  sandbox?: SandboxProvider
  /** 不传时节点的 repo 字段不可用。 */
  repos?: RepoManager
  /** 空间技能目录下的 SKILL.md，运行前同步进沙箱里 harness 认识的技能目录。 */
  skillsDir?: string
  /** 经验召回挂点；不传时不召回。 */
  lessons?: LessonRecall
  /** 协议桥（docs/design/31 §3）；不传时协议对不上的 harness × provider 组合照旧报错。 */
  bridge?: ProviderBridge
}

export interface StartRunInput {
  workflow: WorkflowDefinition
  requirementId: RequirementId
  args?: Record<string, unknown>
  /** 覆盖配置与 workflow 的默认预算。 */
  budget?: RunBudget
  /** 由路由器产生的路由卡（记入 RunState.route 并发 route.decided）。 */
  route?: RouteDecision
  kind?: RunState['kind']
  origin?: RunState['origin']
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
  /**
   * 续跑到下一个人工节点或结束。opts.onStarted 在拿到运行租约、校验通过、即将执行第一个节点时调用一次；
   * 想"开始了就返回"的调用方（界面上的继续 / 回答待办）等它，不等整个 Promise。
   */
  resume(runId: RunId, workflow: WorkflowDefinition, opts?: { onStarted?: () => void }): Promise<RunState>
  /**
   * 重试：把失败 / 阻塞的节点（默认全部，或 nodeIds 指定的）重置为待跑，运行状态回到 running，记 run.retried，然后同 resume 续跑。
   * 已成功或已取消的运行不能重试。
   */
  retry(runId: RunId, workflow: WorkflowDefinition, opts?: { nodeIds?: NodeId[]; reason?: string; onStarted?: () => void }): Promise<RunState>
  cancel(runId: RunId): Promise<void>
  /**
   * 待办已回答、运行还在本进程执行（别的分支在跑）：把回答送进正在跑的调度，返回 true。
   * 运行不在本进程或已经收尾时返回 false，调用方改走 resume。
   */
  notifyAnswered?(runId: RunId): boolean
  /** 公共存放区产物被人改了：把读过它的节点及其下游标记为 stale。 */
  markStale(runId: RunId, cause: ArtifactRef): Promise<NodeId[]>
}

/** 读模型：给 server / web 用的聚合查询（全部从文件计算）。 */
export interface Insights {
  traceGraph(requirementId: RequirementId): Promise<TraceGraph>
  metrics(requirementId: RequirementId): Promise<RequirementMetrics>
}

// ============================================================ 知识库（docs/design/23）

/** 密钥：配置里只存引用（${env:NAME} 或 secret:<name>），明文在 ~/.takt/secrets.json（0600）或环境变量。 */
export interface SecretResolver {
  resolve(ref: string): Promise<string | undefined>
  set(name: string, value: string): Promise<void>
  /** 只返回名字，不返回明文。 */
  list(): Promise<string[]>
}

export interface KnowledgeKindContext {
  stores: ProjectStores
  /** knowledge/<id>/（配置、上传文档、评测集）。 */
  baseDir: string
  /** .takt/knowledge/<id>/v<version>/（索引，可重建）。 */
  indexDir: string
  secrets: SecretResolver
  /** 有嵌入模型时提供。 */
  embed?: (texts: string[]) => Promise<number[][]>
  signal?: AbortSignal
}

export interface KnowledgeBuildProgress {
  stage: string
  done: number
  total: number
  log?: string
  error?: { ref: string; message: string }
}

/** 谁在查：记进 .takt/knowledge/queries.jsonl，用于使用统计、线上采集与引用检测。 */
export interface KnowledgeCaller {
  queryId?: string
  runId?: RunId
  nodeId?: NodeId
  requirementId?: RequirementId
  role?: string
  via?: 'prefetch' | 'tool' | 'playground' | 'eval' | 'steward'
}

/** database / api 类型实际执行的语句或请求（检索测试页展示，拦截时带原因）。 */
export interface KnowledgeExecution {
  kind: 'sql' | 'http'
  text: string
  blocked?: string
}

/** 一种知识库类型（插件扩展点）。页面表单由 configSchema 生成，密钥字段标 format: 'secret'。 */
export interface KnowledgeKind {
  kind: string
  title: string
  /** 适合回答什么（新建向导的类型卡片）。 */
  summary: string
  example?: string
  intents: KnowledgeIntent[]
  configSchema: Record<string, unknown>
  /** 不需要构建的类型（code / history / api 的实时调用）为 false。 */
  needsBuild: boolean
  /** 运行环境是否可用（例如缺数据库驱动）；不可用时向导里置灰并给原因。 */
  available?(): Promise<{ ok: boolean; reason?: string }>
  test(kb: KnowledgeBase, ctx: KnowledgeKindContext): Promise<{ ok: boolean; message: string; preview?: Array<{ title: string; ref: string; snippet: string }> }>
  build?(kb: KnowledgeBase, ctx: KnowledgeKindContext, progress: (p: KnowledgeBuildProgress) => void): Promise<{ stats: NonNullable<KnowledgeBase['stats']> }>
  /** database / api 执行语句时可以返回 { hits, executed }。 */
  query(kb: KnowledgeBase, q: KnowledgeQuery, ctx: KnowledgeKindContext, retrieval: KnowledgeRetrieval): Promise<KnowledgeHit[] | { hits: KnowledgeHit[]; executed?: KnowledgeExecution }>
}

/** 知识库存储与生命周期：配置在 knowledge/<id>/kb.json，构建产物在 .takt/knowledge/<id>/。写操作都记 space-events。 */
export interface KnowledgeStore {
  kinds(): KnowledgeKind[]
  /** 本空间的知识库，加上已绑定的共享知识库。 */
  list(): Promise<KnowledgeBase[]>
  get(id: string): Promise<KnowledgeBase | undefined>
  create(input: Pick<KnowledgeBase, 'name' | 'kind' | 'config'> & Partial<Pick<KnowledgeBase, 'id' | 'description' | 'intents' | 'scope' | 'retrieval'>>, by: Actor, reason: string): Promise<KnowledgeBase>
  update(id: string, patch: Partial<Pick<KnowledgeBase, 'name' | 'description' | 'intents' | 'config' | 'retrieval'>>, by: Actor, reason: string): Promise<KnowledgeBase>
  remove(id: string, by: Actor, reason: string): Promise<void>
  test(id: string): Promise<{ ok: boolean; message: string; preview?: Array<{ title: string; ref: string; snippet: string }> }>
  /** 写入上传的文档（rag / 空间内 wiki），路径相对 knowledge/<id>/content/。 */
  upload(id: string, files: Array<{ path: string; content: Buffer | string }>, by: Actor): Promise<{ docs: number }>
  docs(id: string): Promise<Array<{ path: string; bytes: number; updatedAt: string; indexed: boolean }>>
  /** 后台构建，立即返回；进度用 getBuild 轮询或 onBuild 订阅。 */
  build(id: string, by: Actor, reason: string): Promise<KnowledgeBuild>
  getBuild(id: string, buildId: string): Promise<KnowledgeBuild | undefined>
  builds(id: string, limit?: number): Promise<KnowledgeBuild[]>
  cancelBuild(id: string, buildId: string, by: Actor): Promise<KnowledgeBuild>
  onBuild(listener: (build: KnowledgeBuild) => void): () => void
  /** 发布候选版本：先过评测门槛（docs/design/23）；force 需要 reason，进审计。 */
  publish(id: string, input: { version?: number; by: Actor; reason: string; force?: boolean }): Promise<{ base: KnowledgeBase; gate: { pass: boolean; reasons: string[] } }>
  /** 单库检索（检索测试页）：candidate 用候选版本。 */
  query(id: string, q: KnowledgeQuery, opts?: { version?: 'candidate' | 'published'; retrieval?: Partial<KnowledgeRetrieval>; caller?: KnowledgeCaller }): Promise<{ hits: KnowledgeHit[]; latencyMs: number; tokens: number; intent: KnowledgeIntent; executed?: KnowledgeExecution }>
  /** 运行时检索：按空间绑定 + intent + 角色路由多库，RRF 合并，按预算截断。 */
  route(q: KnowledgeQuery, opts: { role?: string; bases?: string[]; caller?: KnowledgeCaller }): Promise<{ hits: KnowledgeHit[]; bases: Array<{ id: string; version: number }>; latencyMs: number; tokens: number; queryId: string }>
  bindings(): Promise<KnowledgeBinding[]>
  setBindings(bindings: KnowledgeBinding[], by: Actor, reason: string): Promise<KnowledgeBinding[]>
  evalSets(id: string): Promise<Array<{ id: string; title: string; cases: KnowledgeEvalCase[] }>>
  upsertCases(id: string, setId: string, cases: Array<Omit<KnowledgeEvalCase, 'id' | 'createdAt'> & { id?: string }>, by: Actor): Promise<KnowledgeEvalCase[]>
  /** 合成用例（模型从文档块出题）；无模型时报错。产出 status=candidate。 */
  synthesizeCases(id: string, setId: string, count: number, by: Actor): Promise<KnowledgeEvalCase[]>
  /** 从 knowledge.query + knowledge.used 采集候选用例。 */
  harvestCases(id: string, setId: string, by: Actor): Promise<KnowledgeEvalCase[]>
  runEval(id: string, input: { setId: string; variants: KnowledgeEvalVariant[]; by: Actor }): Promise<KnowledgeEvalRun>
  getEvalRun(id: string, runId: string): Promise<KnowledgeEvalRun | undefined>
  evalRuns(id: string): Promise<KnowledgeEvalRun[]>
}
