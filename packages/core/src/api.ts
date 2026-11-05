/**
 * Server ⇄ Web 的 HTTP 协议（server 实现，web 消费）。所有响应都是 JSON，错误统一为 ApiError。
 *
 * | 方法 | 路径 | 响应 |
 * |---|---|---|
 * | GET  | /api/project                                   | ProjectOverview |
 * | GET  | /api/requirements                              | RequirementSummary[] |
 * | GET  | /api/requirements/:id                          | RequirementDetail |
 * | GET  | /api/requirements/:id/artifacts                | ArtifactRecord[] |
 * | GET  | /api/requirements/:id/artifact?path=&version=  | ArtifactContent |
 * | PUT  | /api/requirements/:id/artifact?path=           | 请求体 ArtifactEditRequest → ArtifactEditResponse |
 * | GET  | /api/requirements/:id/comments?path=           | ArtifactComment[] |
 * | POST | /api/requirements/:id/comments                 | 请求体 { path, version, body } → ArtifactComment |
 * | GET  | /api/requirements/:id/trace                    | TraceGraph |
 * | GET  | /api/requirements/:id/metrics                  | RequirementMetrics |
 * | GET  | /api/runs?requirement=                         | RunSummary[] |
 * | GET  | /api/runs/:runId                               | RunDetail |
 * | GET  | /api/runs/:runId/events?after=&node=           | EventEnvelope[] |
 * | GET  | /api/runs/:runId/stream                        | text/event-stream，每条 data 为 EventEnvelope |
 * | GET  | /api/runs/:runId/nodes/:nodeId                 | NodeDetail |
 * | GET  | /api/runs/:runId/audit                         | { ok, brokenAt? }（哈希链校验） |
 * | GET  | /api/attention?pending=1                       | AttentionItem[] |
 * | POST | /api/attention/:requestId                      | 请求体 { decision?, answer? } → AttentionItem |
 * | GET  | /api/harnesses                                 | HarnessInfo[]（设置页：可用性与能力矩阵） |
 * | GET  | /api/models                                    | ModelInfo[] |
 * | --- 项目空间（docs/design/14） | | |
 * | GET  | /api/spaces                                    | SpaceSummary[]（多空间 serve；单空间时只有一项） |
 * | GET  | /api/space                                     | SpaceDetail |
 * | PUT  | /api/space/members                             | 请求体 SpaceMember[] → SpaceDetail |
 * | POST | /api/space/repos                               | 请求体 RepoBinding → SpaceDetail |
 * | POST | /api/space/repos/:repoId/sync                  | { head } |
 * | GET  | /api/space/files?kind=skill|agent&name=        | SpaceFile（SKILL.md / 角色档案原文） |
 * | PUT  | /api/space/files?kind=skill|agent&name=        | 请求体 { content, reason } → SpaceFile |
 * | --- workflow 协同编辑（docs/design/16） | | |
 * | GET  | /api/workflows                                 | WorkflowSummary[] |
 * | GET  | /api/workflows/:id                             | WorkflowDocument |
 * | PATCH| /api/workflows/:id                             | 请求体 WorkflowEditRequest → WorkflowDocument；冲突 409 → WorkflowConflict |
 * | PUT  | /api/workflows/:id/source                      | 请求体 WorkflowSourceRequest → WorkflowDocument；冲突 409 |
 * | PUT  | /api/workflows/:id/layout                      | 请求体 WorkflowLayout → WorkflowLayout |
 * | GET  | /api/workflows/:id/revisions                   | WorkflowRevision[] |
 * | GET  | /api/workflows/:id/revisions/:rev              | { revision, source, diff }（diff 为相对父修订的统一 diff） |
 * | POST | /api/workflows/:id/rollback                    | 请求体 { rev, reason } → WorkflowDocument |
 * | GET  | /api/workflows/:id/stream                      | text/event-stream，data 为 WorkflowChangedEvent |
 * | --- 需求群聊（docs/design/15） | | |
 * | GET  | /api/requirements/:id/room                     | Room |
 * | POST | /api/requirements/:id/room/members             | 请求体 RoomMember[] → Room |
 * | GET  | /api/requirements/:id/chat?after=&limit=       | RoomMessage[] |
 * | POST | /api/requirements/:id/chat                     | 请求体 ChatPostRequest → RoomMessage（@lead 时异步触发 Lead） |
 * | GET  | /api/requirements/:id/chat/stream              | text/event-stream，data 为 RoomMessage |
 * | --- 评审（docs/design/18） | | |
 * | GET  | /api/requirements/:id/reviews                  | ReviewSummary[] |
 * | POST | /api/runs/:runId/nodes/:nodeId/dispositions    | 请求体 ReviewDispositionRequest → ReviewDisposition（人对评审问题的处置，进审计） |
 * | --- 外部参考改进（docs/design/19） | | |
 * | POST | /api/requirements/:id/route                    | 请求体 RoutePreviewRequest → RouteDecision（只预览，不启动） |
 * | GET  | /api/commands                                  | CommandInfo[]（⌘K、Lead、CLI 共用的命令注册表） |
 * | POST | /api/commands/:id                              | 请求体 CommandRunRequest → CommandRunResponse |
 * | GET  | /api/lessons?status=                           | Lesson[] |
 * | PATCH| /api/lessons/:id                               | 请求体 LessonUpdateRequest → Lesson |
 *
 * 任务卡片（RoomMessage kind=task）是只追加的：同一 taskRunId 每次状态变化追加一条，前端按 taskRunId 只显示最新一条。
 * 群聊 SSE 除 RoomMessage 外还会发 `event: lead`，data 为 LeadPresence。
 *
 * 多空间时所有路由都可加前缀 /api/s/:spaceId（例如 /api/s/shop/requirements），不加前缀即默认空间。
 */
import type { AttentionItem } from './interfaces.js'
import type {
  Actor,
  AgentProfile,
  CompletionCheck,
  FailureRecord,
  Lesson,
  LeadPresence,
  QualityMetrics,
  RepoBinding,
  ReviewContinuity,
  ReviewDisposition,
  ReviewNodeDef,
  ReviewRound,
  ReviewVerdict,
  Room,
  RoomMember,
  RoomMessage,
  RouteDecision,
  RunBudget,
  SkillRecord,
  SpaceMember,
  WorkflowSnapshot,
  HarnessCapabilities,
  ProviderProtocol,
  ArtifactRecord,
  CompactionRecord,
  ContextSnapshot,
  EventEnvelope,
  JudgeVerdict,
  NodeKind,
  NodeState,
  NodeStatus,
  Requirement,
  RequirementMetrics,
  RunState,
  SnapshotNode,
  StageDef,
  Tier,
  Usage,
} from './types.js'

export interface ApiError {
  error: string
  detail?: unknown
}

export type StageStatus = 'todo' | 'running' | 'done' | 'failed' | 'waiting_human'

export interface StageProgress extends StageDef {
  status: StageStatus
  /** 该阶段节点完成数 / 总数。 */
  done: number
  total: number
}

export interface RequirementSummary extends Requirement {
  stages: StageProgress[]
  latestRunId?: string
  pendingAttention: number
  usage: Usage
  /** 最近一次流水线运行的当前节点（运行中或等人的那个）。 */
  current?: { runId: string; nodeId: string; title: string; status: NodeStatus }
  /** 最近一次流水线运行的档位。 */
  tier?: Tier
  quality?: QualityMetrics
}

export interface ProjectOverview {
  name: string
  description?: string
  requirements: RequirementSummary[]
  attention: AttentionItem[]
  totals: {
    requirements: number
    active: number
    delivered: number
    blocked: number
    runs: number
    usage: Usage
    /** 全部需求的"已校验 / 已拦截"合计。 */
    verified?: number
    intercepted?: number
  }
}

export interface RequirementDetail extends RequirementSummary {
  artifacts: ArtifactRecord[]
  runs: RunSummary[]
}

export interface ArtifactContent {
  path: string
  version: number
  mediaType: string
  /** 文本内容；二进制产物为 base64 并置 encoding。 */
  content: string
  encoding?: 'utf8' | 'base64'
}

export interface ArtifactEditRequest {
  content: string
  /** 人工修改必须写原因（进审计）。 */
  reason: string
  /** cosmetic：措辞调整，不让下游过期；缺省 semantic。 */
  impact?: 'cosmetic' | 'semantic'
}

export interface ArtifactEditResponse {
  version: number
  /** 因这次修改被标记为 stale 的节点（需要重跑）。 */
  staleNodes: Array<{ runId: string; nodeId: string }>
}

export interface RunSummary {
  runId: string
  workflowId: string
  requirementId: string
  status: RunState['status']
  startedAt: string
  endedAt?: string
  progress: { done: number; total: number; failed: number }
  usage: Usage
  kind?: RunState['kind']
  origin?: RunState['origin']
  tier?: Tier
}

/** DAG 画布用的图：静态定义 + 运行状态 + 动态展开合并后的结果。 */
export interface GraphNode {
  id: string
  kind: NodeKind
  title: string
  stage?: string
  status: NodeStatus
  /** planner 展开出来的节点指向其 planner；loop 体内节点指向其 loop。 */
  parent?: string
  role?: string
  harness?: string
  attempts: number
  iteration?: number
  usage?: Usage
  /** review 节点：当前修订与轮次、打回次数（画轮次角标用）。 */
  revision?: number
  round?: number
  reworks?: number
  goal?: string
  summary?: string
}

export interface GraphEdge {
  from: string
  to: string
  /** dep：依赖；route：判决路由（虚线）；expand：动态展开。 */
  kind: 'dep' | 'route' | 'expand'
  label?: string
}

export interface RunDetail {
  run: RunState
  workflow: { id: string; title: string; version: string; stages: StageDef[] }
  /** 阶段进度（server 用 core 的 stageProgress 计算），web 不再自行推导。 */
  stages?: StageProgress[]
  /** 本次运行的总用量（按全部 node.finished 事件累加）。 */
  usage?: Usage
  graph: { nodes: GraphNode[]; edges: GraphEdge[] }
  budget?: BudgetStatus
  quality?: QualityMetrics
}

export interface BudgetStatus {
  budget: RunBudget
  used: { tokens: number; costUsd?: number; minutes: number }
  /** 各项用量 / 预算的最大值；没有预算时为 0。 */
  ratio: number
  state: 'ok' | 'warning' | 'exhausted'
}

export interface NodeDetail {
  state: NodeState
  kind: NodeKind
  title: string
  stage?: string
  role?: string
  /** 节点实际收到的 prompt（渲染后）。 */
  prompt?: string
  inputs: Array<{ path: string; version?: number }>
  outputs: Array<{ path: string; version: number; kind: string }>
  context: { snapshots: ContextSnapshot[]; compactions: CompactionRecord[] }
  verdicts?: JudgeVerdict[]
  gate?: { pass: boolean; checks: Array<{ id: string; pass: boolean; score?: number; message?: string }> }
  /** gate 节点的检查定义（来自快照，含 rubric 阈值）。 */
  checks?: SnapshotNode['checks']
  /** review 节点：配置与每轮记录（含历史修订）、正交状态与人工处置。 */
  review?: { config: NonNullable<SnapshotNode['review']>; rounds: ReviewRound[]; status: ReviewStatus; facets?: ReviewFacets; dispositions?: ReviewDisposition[] }
  goal?: string
  summary?: string
  /** 完成标准与最近一次自检。 */
  completion?: string[]
  completionChecks?: CompletionCheck[]
  failures?: FailureRecord[]
  events: EventEnvelope[]
}

// ------------------------------------------------------------ 项目空间

export interface SpaceSummary {
  id: string
  name: string
  description?: string
  requirements: number
  active: number
}

export interface SpaceDetail extends SpaceSummary {
  members: SpaceMember[]
  repos: Array<RepoBinding & { status: 'ready' | 'missing' | 'syncing' | 'error'; head?: string; message?: string }>
  skills: SkillRecord[]
  agents: Array<Pick<AgentProfile, 'role' | 'title' | 'description' | 'harness' | 'writeScope'>>
  workflows: WorkflowSummary[]
  knowledge: Array<{ id: string; kind: string; description: string }>
}

export interface SpaceFile {
  kind: 'skill' | 'agent'
  name: string
  path: string
  content: string
}

// ------------------------------------------------------------ workflow 协同编辑

/** 属性值：字面量在画布上用表单编辑；代码值显示为代码块。 */
export type EditableValue = { kind: 'literal'; value: unknown } | { kind: 'code'; code: string }

export interface EditableNode {
  id: string
  /** 构造函数名对应的节点类型。 */
  kind: NodeKind
  props: Record<string, EditableValue>
  /** loop 的循环体。 */
  body?: EditableNode[]
}

export interface WorkflowDiagnostic {
  severity: 'error' | 'warning'
  message: string
  line?: number
  column?: number
  nodeId?: string
}

export interface EditableWorkflow {
  meta: {
    id: string
    title: EditableValue
    description?: EditableValue
    version: EditableValue
    /** 路由与总负责元数据（docs/design/19）；缺省表示源码里没写。 */
    useWhen?: EditableValue
    tiers?: EditableValue
    leadInstructions?: EditableValue
    dynamicRules?: EditableValue
    budget?: EditableValue
  }
  stages: EditableValue
  nodes: EditableNode[]
  /** 不满足受限子集时为 false：画布只读。 */
  editable: boolean
}

export type WorkflowEdit =
  | { op: 'addNode'; kind: NodeKind; props: Record<string, EditableValue>; after?: string | null; parent?: string }
  | { op: 'removeNode'; id: string }
  | { op: 'setProp'; id: string; key: string; value: EditableValue | null }
  | { op: 'setNeeds'; id: string; needs: string[] }
  | { op: 'moveNode'; id: string; after: string | null; parent?: string | null }
  | { op: 'setStages'; stages: Array<{ id: string; title: string }> }
  | { op: 'setMeta'; key: 'title' | 'description' | 'version'; value: string }
  /** 设置 / 删除（null）路由与总负责元数据。 */
  | { op: 'setMetaValue'; key: 'useWhen' | 'tiers' | 'leadInstructions' | 'dynamicRules' | 'budget'; value: EditableValue | null }

export interface WorkflowLayout {
  nodes: Record<string, { x: number; y: number }>
  viewport?: { x: number; y: number; zoom: number }
}

export interface WorkflowRevision {
  /** 源码 sha256。 */
  rev: string
  parent?: string
  author: Actor
  reason?: string
  at: string
  /** 改动摘要（例如"新增节点 review-prd；修改 spec.prompt"）。 */
  summary?: string
}

export interface WorkflowSummary {
  id: string
  title: string
  /** 相对空间根目录的文件路径。 */
  file: string
  rev: string
  editable: boolean
  updatedAt: string
  nodes: number
  /** 最近使用它的运行数。 */
  runs: number
}

export interface WorkflowDocument {
  id: string
  file: string
  source: string
  rev: string
  model: EditableWorkflow
  layout: WorkflowLayout
  /** 校验通过时的结构快照（画布按它画图，与运行页一致）。 */
  snapshot?: WorkflowSnapshot
  diagnostics: WorkflowDiagnostic[]
}

export interface WorkflowEditRequest {
  baseRev: string
  edits: WorkflowEdit[]
  reason?: string
}

export interface WorkflowSourceRequest {
  baseRev: string
  source: string
  reason?: string
}

/** 409：基线已变化且自动三方合并失败。 */
export interface WorkflowConflict {
  error: 'conflict'
  base: string
  ours: string
  theirs: string
  /** 带冲突标记的合并结果。 */
  merged: string
  currentRev: string
}

export interface WorkflowChangedEvent {
  workflowId: string
  revision: WorkflowRevision
}

// ------------------------------------------------------------ 群聊与评审

export interface ChatPostRequest {
  text: string
  mentions?: string[]
  replyTo?: string
}

export type ReviewStatus = 'pending' | 'in_review' | 'revising' | 'passed' | 'exhausted' | 'reworked'

export interface ReviewSummary {
  runId: string
  nodeId: string
  title: string
  target: ReviewNodeDef['target']
  status: ReviewStatus
  round: number
  maxRounds: number
  reworks: number
  /** 最近一轮每个评审者的结论。 */
  latest: Array<{ reviewer: string; verdict: ReviewVerdict; score?: number; openIssues: number }>
  revision?: number
  facets?: ReviewFacets
}

/**
 * 评审的正交状态（docs/design/19）：阶段、结论、覆盖、新鲜度分别给出，不压成一个词。
 * "no_findings" 表示没发现问题，界面上不显示为"通过"。
 */
export interface ReviewFacets {
  phase: 'pending' | 'reviewing' | 'revising' | 'signoff' | 'done' | 'exhausted' | 'reworked' | 'failed'
  outcome?: 'approved' | 'changes_requested' | 'rejected' | 'no_findings' | 'escalated'
  /** full：所有评审者都给出结论且目标都可读；partial：有缺失。 */
  coverage: 'full' | 'partial'
  /** stale：评审之后目标产物 / 代码又变了。 */
  freshness: 'current' | 'stale' | 'unknown'
  /** 按人工处置过滤后的未关闭问题（groupKey 去重）。 */
  open: { blocker: number; major: number; minor: number; nit: number }
  /** 最近一轮的问题观察统计。 */
  observed?: Partial<Record<ReviewContinuity['observation'], number>> & { regressed?: number }
}

export interface ReviewDispositionRequest {
  groupKey: string
  state: ReviewDisposition['state']
  reason: string
}

export interface RoutePreviewRequest {
  /** 不给时由路由器从需求标题、产物与群聊推断。 */
  hint?: string
  /** 人工指定档位（改档），需要 reason。 */
  tier?: Tier
  reason?: string
}

export interface CommandInfo {
  id: string
  title: string
  kind: 'query' | 'command'
  /** read：只读；write：改状态；dangerous：不可逆或外部写入。 */
  risk: 'read' | 'write' | 'dangerous'
  minRole?: SpaceMember['role']
  /** 输入的 JSON Schema（⌘K 按它生成简单表单）。 */
  input: Record<string, unknown>
  keywords?: string[]
  /** 适用范围：需求页、运行页等上下文里自动带入的参数名。 */
  scope?: Array<'requirement' | 'run' | 'node'>
}

export interface CommandRunRequest {
  input: Record<string, unknown>
  /** 写审计的原因（write / dangerous 必填）。 */
  reason?: string
}

export interface CommandRunResponse {
  ok: boolean
  message: string
  result?: unknown
}

export interface LessonUpdateRequest {
  status?: Lesson['status']
  title?: string
  body?: string
  trigger?: Lesson['trigger']
  reason: string
}

export type { LeadPresence, Room, RoomMember, RoomMessage }

export interface HarnessInfo {
  id: string
  displayName: string
  /** builtin：内置适配器；cli：声明式 CLI 适配；plugin：插件提供；native：内置 agent loop。 */
  source: 'builtin' | 'cli' | 'plugin' | 'native'
  available: boolean
  reason?: string
  capabilities: HarnessCapabilities
  /** 哪些角色默认用它。 */
  roles: string[]
}

export interface ModelInfo {
  alias: string
  provider: string
  protocol: ProviderProtocol
  id: string
  contextWindow?: number
  price?: { input: number; output: number }
  /** 对应的 apiKeyEnv 是否已设置（不返回值）。 */
  keyPresent: boolean
}

export type { AttentionItem, Lesson, QualityMetrics, RequirementMetrics, RouteDecision }
