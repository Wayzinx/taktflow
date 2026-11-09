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
 * | --- 模型与 Harness 配置（docs/design/27 §4） | | |
 * | GET  | /api/space/runtime                             | RuntimeConfig |
 * | PATCH| /api/space/runtime                             | 请求体 RuntimeConfigPatch → RuntimeConfig（owner；baseRevision 不一致 409；校验失败 400 并指出字段；不重启 serve 即生效） |
 * | POST | /api/space/runtime/test                        | 请求体 RuntimeTestRequest → RuntimeTestResult（provider 只列模型不计费；model 只有 allowBilled 才发 1 token 请求；harness 跑探测 / ACP 握手） |
 * | PUT  | /api/secrets/:name                             | 请求体 { value, reason } → SecretStatus（owner；存本机密钥库，不进空间目录与 git；任何接口都不回传值） |
 * | DELETE| /api/secrets/:name                            | 请求体 { reason } → SecretStatus |
 * | --- 项目空间（docs/design/14） | | |
 * | GET  | /api/spaces                                    | SpaceSummary[]（多空间 serve；单空间时只有一项） |
 * | GET  | /api/space                                     | SpaceDetail |
 * | PUT  | /api/space/members                             | 请求体 SpaceMember[] → SpaceDetail |
 * | POST | /api/space/repos                               | 请求体 RepoBinding → SpaceDetail |
 * | POST | /api/space/repos/:repoId/sync                  | { head } |
 * | GET  | /api/space/files?kind=skill|agent&name=        | SpaceFile（SKILL.md / 角色档案原文） |
 * | PUT  | /api/space/files?kind=skill|agent&name=        | 请求体 { content, reason } → SpaceFile |
 * | --- 角色与自动化（docs/design/30 §3、§4） | | |
 * | GET  | /api/space/agents                              | AgentRoleView[]（每个角色的结构化字段、生效的 harness 及来源、被哪些 workflow 节点用到） |
 * | GET  | /api/space/agents/:role                        | AgentRoleView |
 * | PUT  | /api/space/agents/:role                        | 请求体 AgentRoleWrite → AgentRoleView（owner；改 frontmatter、正文原样保留；revision 不一致 409；不存在时新建） |
 * | DELETE| /api/space/agents/:role                       | 请求体 { reason } → 204（owner；还有 workflow 节点用它时 409 并列出节点） |
 * | GET  | /api/space/automations                         | AutomationsView（自动化、通知渠道、各自状态） |
 * | PUT  | /api/space/automations/:id                     | 请求体 { automation: AutomationConfig, reason } → AutomationView（owner；cron / 渠道 / workflow 校验失败 400 并指出字段） |
 * | DELETE| /api/space/automations/:id                    | 请求体 { reason } → 204（owner） |
 * | POST | /api/space/automations/:id/trigger             | 请求体 { reason } → AutomationRunRecord（立即执行一次；trigger 为 manual） |
 * | GET  | /api/space/automations/:id/runs                | AutomationRunRecord[]（最近 20 次，新的在前） |
 * | POST | /api/space/automations/:id/runs/:recordId/retry | 请求体 { reason } → AutomationRunRecord（按原触发输入重跑；只有 failed 的能重试） |
 * | PUT  | /api/space/channels/:id                        | 请求体 { channel: ChannelConfig, reason } → ChannelView（owner） |
 * | DELETE| /api/space/channels/:id                       | 请求体 { reason } → 204（owner；还有自动化引用时 409 并列出） |
 * | POST | /api/space/channels/:id/test                   | 请求体 { reason } → AutomationDelivery（发一条测试消息） |
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
 * | POST | /api/route/preview                              | 请求体 RoutePreviewDraftRequest → RouteDecision（还没有需求时按草稿文本预估；与不指定流程时创建需求的路由一致，不落盘） |
 * | GET  | /api/commands                                  | CommandInfo[]（⌘K、Lead、CLI 共用的命令注册表） |
 * | POST | /api/commands/:id                              | 请求体 CommandRunRequest → CommandRunResponse |
 * | GET  | /api/lessons?status=                           | Lesson[] |
 * | PATCH| /api/lessons/:id                               | 请求体 LessonUpdateRequest → Lesson |
 * | GET  | /api/me                                        | Viewer（当前用户：请求头 x-takt-user，缺省为空间第一个 owner） |
 * | PATCH| /api/space/repos/:repoId                       | 请求体 RepoUpdateRequest → SpaceDetail |
 * | --- 评测与归因（docs/design/20） | | |
 * | GET  | /api/eval/scorecards?by=node|recipe|skill&workflow= | NodeScorecard[] |
 * | GET  | /api/eval/cases?target=&retired=1              | EvalCase[]（target 形如 node:<workflow>/<node> 或 skill:<name>；默认不含已退役样本，retired=1 时一并返回） |
 * | POST | /api/eval/cases/collect                        | 请求体 EvalCollectRequest → { added: string[] }（从历史与已确认缺陷生成用例） |
 * | GET  | /api/eval/runs                                 | EvalRun[]（不含 results 明细时 results 为空数组） |
 * | GET  | /api/eval/runs/:id                             | EvalRun |
 * | POST | /api/eval/runs                                 | 请求体 EvalRunRequest → EvalRun（后台执行，轮询 GET 看进度） |
 * | GET  | /api/eval/runs/:id/output?case=&variant=       | { files: Array<{ path, content }> }（输出快照；不存在为 404） |
 * | GET  | /api/requirements/:id/defects                  | DefectDetail[] |
 * | POST | /api/requirements/:id/defects                  | 请求体 DefectReportRequest → DefectDetail |
 * | POST | /api/requirements/:id/defects/:defectId/attribute | 无请求体 → DefectDetail（预检 + 归因 Agent，后台执行） |
 * | POST | /api/requirements/:id/defects/:defectId/confirm   | 请求体 DefectConfirmRequest → DefectDetail |
 *
 * —— 归因可信度（docs/design/21）——
 * | GET  | /api/runs/:runId/snapshots/:checkpointId           | SnapshotManifest |
 * | GET  | /api/runs/:runId/snapshots/:checkpointId/file?path= | ArtifactContent（快照里的文件；path 防穿越） |
 * | GET  | /api/requirements/:id/observations?source=&run=   | Observation[] |
 * | PATCH| /api/requirements/:id/defects/:defectId           | 请求体 DefectUpdateRequest → DefectDetail（baseRevision 不一致 409） |
 * | GET  | /api/requirements/:id/defects/merge-suggestions   | DefectMergeSuggestion[] |
 * | POST | /api/requirements/:id/defects/merge-suggestions/:sid | 请求体 { decision: 'accept' \| 'reject' \| 'undo', reason } → DefectMergeSuggestion |
 * | POST | /api/requirements/:id/defects/:defectId/checkpoints/:checkpointId | 请求体 MissDecisionRequest → DefectDetail（人改判 / 确认某个检查点的漏检结论） |
 * | POST | /api/eval/samples                               | 请求体 EvalSampleRequest → EvalCase（从确认的漏检或人确认无问题的评审调用生成样本） |
 * | POST | /api/eval/samples/:caseId/retire                | 请求体 { reason } → EvalCase |
 * | GET  | /api/quality/status                             | QualityStatus |
 * | POST | /api/quality/sync                               | 请求体 { runId?, reason } → QualityStatus |
 * | POST | /api/quality/repair                             | 请求体 { reason } → QualityStatus（只补锚点；链被篡改 409） |
 *
 * —— 运行透明与回退（docs/design/26）——
 * | GET  | /api/runs/:runId/timeline                       | RunTimeline |
 * | GET  | /api/runs/:runId/nodes/:nodeId/changes          | NodeChanges |
 * | GET  | /api/runs/:runId/nodes/:nodeId/diff?path=       | { patch }（统一 diff；不给 path 为整个节点） |
 * | POST | /api/runs/:runId/nodes/:nodeId/rewind/preview   | 无请求体 → RewindPreview |
 * | POST | /api/runs/:runId/nodes/:nodeId/rewind           | 请求体 RewindRequest → RewindResult（token 与当前状态不符 409） |
 * | POST | /api/steward/delegations/:messageId/resend      | 请求体 { reason } → StewardDelegation（只允许 uncertain / expired） |
 * | POST | /api/requirements/:id/room/tasks/:messageId/resend | 请求体 { reason } → RoomMessage（新的 task 消息；只允许 receipt 为 uncertain / expired，派发链与跳数沿用原任务） |
 *
 * —— 需求与空间增删改（docs/design/22）——
 * | GET  | /api/server                                    | ServerInfo（是否多空间、管家是否已配置模型） |
 * | POST | /api/requirements                              | 请求体 RequirementCreateRequest → RequirementCreateResponse |
 * | PATCH| /api/requirements/:id                          | 请求体 RequirementUpdateRequest → RequirementSummary |
 * | POST | /api/requirements/:id/archive                  | 请求体 { reason } → RequirementSummary（有运行中的运行时 409） |
 * | POST | /api/requirements/:id/restore                  | 请求体 { reason } → RequirementSummary |
 * | DELETE| /api/requirements/:id                         | 请求体 { reason } → 204（只允许没有任何运行记录的需求，否则 409） |
 * | GET  | /api/spaces?archived=1                         | SpaceSummary[]（archived=1 时只返回已归档的） |
 * | POST | /api/spaces                                    | 请求体 SpaceCreateRequest → SpaceSummary（单空间模式 409；id / 名称重复 409） |
 * | PATCH| /api/spaces/:id                                | 请求体 SpaceUpdateRequest → SpaceSummary |
 * | POST | /api/spaces/:id/archive                        | 请求体 { reason } → SpaceSummary（有运行中的需求时 409） |
 * | POST | /api/spaces/:id/restore                        | 请求体 { reason } → SpaceSummary |
 * | DELETE| /api/spaces/:id                               | 请求体 { confirm: <id>, reason } → 204（只允许已归档的空间） |
 * | POST | /api/workflows/:id/convert                     | 请求体 WorkflowConvertRequest → WorkflowConvertResult（把不可编辑写法改写为 defineWorkflow；baseRev 不一致 409） |
 *
 * —— 管家（docs/design/22）；按 x-takt-user 区分用户，数据在 <spaces 根>/.steward/<userId>/ ——
 * | GET  | /api/steward/threads?archived=1                | StewardThread[]（默认不含已归档；archived=1 只列已归档。置顶的排最前，其余按 updatedAt 倒序） |
 * | PATCH| /api/steward/threads/:id                       | 请求体 StewardThreadPatch → StewardThread（docs/design/30 §2：重命名、置顶、归档、换 harness / 模型） |
 * | DELETE| /api/steward/threads/:id                      | → 204（连同消息删除；有未决提案的会话 409，先处理或归档） |
 * | GET  | /api/steward/runtime-choices                   | StewardRuntimeChoice[]（管家能用的 harness × 模型组合，含不可用原因） |
 * | POST | /api/steward/mcp                               | MCP（streamable HTTP，JSON-RPC 2.0）：把管家工具开放给外部 harness；只认本轮签发的 Bearer 令牌 |
 * | POST | /api/steward/threads                           | 请求体 StewardPostRequest → { thread, message }（新会话 + 第一条消息） |
 * | GET  | /api/steward/threads/:id                       | { thread, messages: StewardMessage[], proposals: Proposal[] } |
 * | POST | /api/steward/threads/:id/messages              | 请求体 StewardPostRequest → StewardMessage（用户消息；管家回复走 stream） |
 * | GET  | /api/steward/threads/:id/stream                | text/event-stream，data 为 StewardStreamEvent |
 * | POST | /api/steward/messages/:id/feedback             | 请求体 { rating, reason? } → StewardMessage |
 * | GET  | /api/steward/proposals?status=                 | Proposal[] |
 * | POST | /api/steward/proposals/:id/approve             | 请求体 ProposalDecisionRequest → Proposal（hash 不一致或基线变了 409，状态 stale） |
 * | POST | /api/steward/proposals/:id/reject              | 请求体 { reason? } → Proposal |
 * | POST | /api/steward/proposals/:id/undo                | 请求体 { reason? } → Proposal |
 * | GET  | /api/steward/risks?space=&state=               | Risk[] |
 * | POST | /api/steward/risks/:key/state                  | 请求体 RiskStateRequest → Risk（key 需 encodeURIComponent） |
 * | GET  | /api/steward/digest?since=&peek=1              | Digest（since 缺省为上次查看；peek=1 只读，不标记已读也不记 digest.open） |
 * | GET  | /api/steward/feed                              | StewardFeedItem[]（"动态"：汇报、风险变化、提案结果） |
 * | GET  | /api/steward/prefs                             | StewardPrefs |
 * | PUT  | /api/steward/prefs                             | 请求体 StewardPrefs → StewardPrefs |
 * | GET  | /api/steward/profile                           | { content }（记忆 profile.md） |
 * | PUT  | /api/steward/profile                           | 请求体 { content } → { content } |
 * | GET  | /api/steward/suggestions?page=&space=&id=      | string[]（页内"让管家……"建议，最多 3 条） |
 * | GET  | /api/steward/metrics                           | ProductMetric[]（产品健康：每个功能的效率与迭代信号） |
 * | POST | /api/steward/events                            | 请求体 ProductEvent → 204（页面上报的交互事件：对话框打开 / 提交、建议点击、汇报打开；只存本机） |
 * | GET  | /api/steward/stream                            | text/event-stream，data 为 StewardFeedItem（全局动态与未读数） |
 * —— 管家 Solo（docs/design/28）；跨调用者看得见的全部空间 ——
 * | GET  | /api/steward/find?q=&types=&space=&limit=      | StewardFindResult（编号精确 > 标题模糊 > 最近有动静；types 逗号分隔，limit 默认 8、最多 20） |
 * | GET  | /api/steward/picks?limit=                      | { items: StewardPick[] }（Solo 首页"你可能想看"：等你 > 失败 > 有风险 > 刚变化 > 在跑；limit 默认 6） |
 *
 * —— 知识库（docs/design/23）；空间内，可加 /api/s/:spaceId 前缀 ——
 * | GET  | /api/knowledge/kinds                           | KnowledgeKindInfo[] |
 * | GET  | /api/knowledge/bases                           | KnowledgeBaseSummary[] |
 * | POST | /api/knowledge/bases                           | 请求体 KnowledgeCreateRequest → KnowledgeBaseSummary |
 * | GET  | /api/knowledge/bases/:id                       | KnowledgeBaseDetail |
 * | PATCH| /api/knowledge/bases/:id                       | 请求体 KnowledgeUpdateRequest → KnowledgeBaseSummary |
 * | DELETE| /api/knowledge/bases/:id                      | 请求体 { reason } → 204 |
 * | POST | /api/knowledge/bases/:id/test                  | 无请求体 → KnowledgeTestResult |
 * | POST | /api/knowledge/bases/:id/upload                | 请求体 KnowledgeUploadRequest → { docs } |
 * | GET  | /api/knowledge/bases/:id/docs                  | KnowledgeDoc[] |
 * | POST | /api/knowledge/bases/:id/builds                | 请求体 { reason } → KnowledgeBuild（后台执行） |
 * | GET  | /api/knowledge/bases/:id/builds/:buildId       | KnowledgeBuild |
 * | GET  | /api/knowledge/bases/:id/builds/:buildId/stream | text/event-stream，data 为 KnowledgeBuild |
 * | POST | /api/knowledge/bases/:id/builds/:buildId/cancel | 无请求体 → KnowledgeBuild |
 * | POST | /api/knowledge/bases/:id/query                 | 请求体 KnowledgeQueryRequest → KnowledgeQueryResponse |
 * | POST | /api/knowledge/bases/:id/publish               | 请求体 KnowledgePublishRequest → KnowledgePublishResponse（门槛未过且未 force 时 409，响应体同样是 KnowledgePublishResponse） |
 * | GET  | /api/knowledge/bases/:id/evals                 | KnowledgeEvalSet[] |
 * | PUT  | /api/knowledge/bases/:id/evals/:setId/cases    | 请求体 { cases } → KnowledgeEvalCase[]（新增或按 id 更新） |
 * | POST | /api/knowledge/bases/:id/evals/:setId/synthesize | 请求体 { count } → KnowledgeEvalCase[] |
 * | POST | /api/knowledge/bases/:id/evals/:setId/harvest  | 无请求体 → KnowledgeEvalCase[] |
 * | GET  | /api/knowledge/bases/:id/eval-runs             | KnowledgeEvalRun[] |
 * | POST | /api/knowledge/bases/:id/eval-runs             | 请求体 KnowledgeEvalRunRequest → KnowledgeEvalRun（后台执行，轮询） |
 * | GET  | /api/knowledge/bases/:id/eval-runs/:runId      | KnowledgeEvalRun |
 * | GET  | /api/knowledge/bindings                        | KnowledgeBinding[] |
 * | PUT  | /api/knowledge/bindings                        | 请求体 { bindings, reason } → KnowledgeBinding[] |
 * | GET  | /api/knowledge/secrets                         | string[]（只返回名字） |
 * | PUT  | /api/knowledge/secrets/:name                   | 请求体 { value } → { name }（只写不读） |
 * | POST | /api/knowledge/migrate                         | 请求体 { dryRun? } → KnowledgeMigration（旧 takt.config.json knowledge 条目 → kb.json） |
 *
 * 任务卡片（RoomMessage kind=task）是只追加的：同一 taskRunId 每次状态变化追加一条，前端按 taskRunId 只显示最新一条。
 * 群聊 SSE 除 RoomMessage 外还会发 `event: lead`，data 为 LeadPresence。
 *
 * 多空间时所有路由都可加前缀 /api/s/:spaceId（例如 /api/s/shop/requirements），不加前缀即默认空间。
 */
import type { AttentionItem, KnowledgeCaller } from './interfaces.js'
import type {
  AcpHarnessConfig,
  Actor,
  AutomationConfig,
  AutomationEvent,
  ChannelConfig,
  Checkpoint,
  CliHarnessConfig,
  HarnessOverride,
  ModelConfig,
  ProviderConfig,
  DefectMergeSuggestion,
  DelegationStatus,
  EvalGate,
  EvalReport,
  GateCheckResult,
  Invocation,
  InvocationEnd,
  MissAssessment,
  MissVerdict,
  Observation,
  ReviewIssueEntry,
  ReviewRecord,
  RewindPoint,
  SnapshotManifest,
  AgentProfile,
  CompletionCheck,
  Defect,
  DefectAttribution,
  EvalCase,
  EvalRun,
  EvalTarget,
  EvalVariant,
  ExternalLink,
  FailureRecord,
  KnowledgeBase,
  KnowledgeBinding,
  KnowledgeBuild,
  KnowledgeEvalCase,
  KnowledgeEvalRun,
  KnowledgeEvalVariant,
  KnowledgeHit,
  KnowledgeIntent,
  KnowledgeRetrieval,
  RequirementId,
  RunId,
  NodeId,
  Timestamp,
  HarnessSelector,
  NodeRecipe,
  VerdictCategory,
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
  /** 最近 12 次运行（含 Lead 派发的任务），按开始时间升序；需求行的迷你柱用（docs/design/25 §3）。 */
  recentRuns?: RunSpark[]
}

export interface RunSpark {
  runId: string
  status: RunState['status']
  startedAt: string
  tokens: number
  kind?: RunState['kind']
}

/** 一天的活动量，按运行开始日（服务端本地时区）计。 */
export interface DailyActivity {
  /** YYYY-MM-DD */
  day: string
  runs: number
  tokens: number
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
    interceptedBy?: QualityMetrics['interceptedBy']
    /** 最近 14 天（含今天、无活动的天补 0），读数格迷你折线用。 */
    daily?: DailyActivity[]
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
  /** 运行中在干什么（docs/design/26 §1）：server 从最近的 harness 事件推导；web 按 since 计时、按工具名归动词。 */
  activity?: NodeActivity
}

export interface NodeActivity {
  state: 'thinking' | 'tool' | 'compacting' | 'waiting_tool'
  /** state 为 tool / waiting_tool 时：工具名与输入（web 用动词表转成动作行）。 */
  tool?: string
  input?: string
  since: string
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
  /** 检查项带三态 status（docs/design/21 §4）；M4 之前的记录没有 status，按 pass 推断。 */
  gate?: { pass: boolean; checks: GateCheckResult[] }
  /** gate 节点的检查定义（来自快照，含 rubric 阈值）。 */
  checks?: SnapshotNode['checks']
  /** review 节点：配置与每轮记录（含历史修订）、正交状态与人工处置。 */
  review?: { config: NonNullable<SnapshotNode['review']>; rounds: ReviewRound[]; status: ReviewStatus; revision?: number; facets?: ReviewFacets; dispositions?: ReviewDisposition[] }
  /** 本次执行的配方（docs/design/20）。 */
  recipe?: NodeRecipe
  goal?: string
  summary?: string
  /** 完成标准与最近一次自检。 */
  completion?: string[]
  completionChecks?: CompletionCheck[]
  failures?: FailureRecord[]
  events: EventEnvelope[]
  /** 检查点（docs/design/21 §1）：含没执行的；按调度顺序。 */
  checkpoints?: CheckpointDetail[]
  /** 本节点的全部调用（docs/design/21 §2）。 */
  invocations?: Invocation[]
  /** review 节点的问题台账（按系统键）。 */
  issues?: ReviewIssueEntry[]
  /** 本节点改了什么（docs/design/26 §5）。 */
  changes?: NodeChanges
}

export interface CheckpointDetail extends Checkpoint {
  status: 'scheduled' | 'done' | 'error' | 'skipped'
  error?: string
  endedAt?: string
  snapshot?: SnapshotManifest
  invocations: string[]
  /** 评审者 / 裁决者：结论与职责条目逐条结论。 */
  record?: ReviewRecord
  /** 门禁检查项：三态结果。 */
  gate?: GateCheckResult
}

/** 时间泳道（docs/design/26 §2）。时间都是 ISO 字符串；进行中的段 end 缺省。 */
export interface RunTimeline {
  start: string
  end?: string
  lanes: Array<{
    nodeId: string
    title: string
    kind: NodeKind
    stage?: string
    parent?: string
    segments: Array<{
      kind: 'queue' | 'run' | 'wait' | 'tool' | 'compact'
      start: string
      end?: string
      /** tool：工具名与输入；wait：待办 requestId。 */
      tool?: string
      input?: string
      ok?: boolean
      requestId?: string
      invocationId?: string
      /** ≥ 15 秒的工具步骤。 */
      long?: boolean
    }>
    /** Agent 节点的调用（fallback 换 harness 时能看见）。 */
    invocations?: Array<{ id: string; harness: string; model?: string; start: string; end?: string; outcome?: InvocationEnd['outcome']; attempt?: number; fallbackIndex?: number }>
  }>
  /** 上下文曲线：每轮输入 token（含缓存）。 */
  context: Array<{ nodeId: string; window?: number; points: Array<{ at: string; tokens: number }>; compactions: Array<{ at: string; before: number; after: number }> }>
}

/** 节点改动卡（docs/design/26 §5）。 */
export interface NodeChanges {
  files: Array<{
    path: string
    scope: 'repo' | 'workspace'
    repo?: string
    status: 'added' | 'modified' | 'deleted' | 'renamed'
    add: number
    del: number
    /** 存放区产物：本节点写之前 / 之后的版本。 */
    from?: number
    to?: number
    oldPath?: string
  }>
  add: number
  del: number
  rewindPoint?: RewindPoint
  /** 不能回退时写明原因（按钮置灰并显示它）。 */
  rewindBlocked?: string
}

export interface RewindPreview {
  nodeId: string
  files: NodeChanges['files']
  /** 会因此过期、需要重跑的节点（含本节点）。 */
  stale: Array<{ runId: string; nodeId: string; title?: string }>
  /** 有值时不能执行（运行中 / 下游在运行 / 工作树有外部未提交改动 / 没有回退点）。 */
  blocked?: string
  /** 预览时的状态指纹；执行时带回，状态变了返回 409。 */
  token: string
}

export interface RewindRequest {
  token: string
  reason: string
}

export interface RewindResult {
  /** version：存放区产物回退后写出的新版本；仓库文件与保留的新建产物（from 为空）没有。 */
  files: Array<RewindPreview['files'][number] & { version?: number }>
  stale: RewindPreview['stale']
}

// ------------------------------------------------------------ 项目空间

export interface SpaceSummary {
  id: string
  name: string
  description?: string
  requirements: number
  active: number
  /** 空间色（切换器方块、空间卡片）。 */
  color?: string
  /** 已归档（只在 ?archived=1 的列表里出现）。 */
  archived?: boolean
  archivedAt?: string
  /** 未处理风险数（管家风险引擎）。 */
  risks?: number
  pendingAttention?: number
  lastActivityAt?: string
}

export interface SpaceDetail extends SpaceSummary {
  members: SpaceMember[]
  repos: Array<RepoBinding & { status: 'ready' | 'missing' | 'syncing' | 'error'; head?: string; message?: string }>
  skills: SkillRecord[]
  agents: Array<Pick<AgentProfile, 'role' | 'title' | 'description' | 'harness' | 'writeScope'>>
  workflows: WorkflowSummary[]
  knowledge: Array<{ id: string; kind: string; description: string }>
}

// ------------------------------------------------------------ 角色（docs/design/30 §3）

/** 生效值来自哪一层：节点 > 角色 > 空间默认（config.roles）> 内置默认。 */
export type SettingSource = 'role' | 'space-default' | 'builtin'

export interface AgentRoleView {
  role: string
  title: string
  description: string
  /** 档案文件（相对空间根目录）；插件 / 内置角色没有文件时为空，第一次保存会在空间里建一份。 */
  path?: string
  origin: 'space' | 'plugin' | 'builtin'
  /** 档案内容的哈希；PUT 时作为 baseRevision。 */
  revision: string
  /** 档案里写的 harness；没写为空。 */
  harness?: HarnessSelector
  /** 实际生效的 harness 及来源。 */
  effective: { harness: HarnessSelector; source: SettingSource }
  skills: string[]
  /** 能读的知识库（KnowledgeBase.id）；不写即空间绑定的全部。 */
  knowledge?: string[]
  writeScope: string[]
  readScope?: string[]
  allowBash?: boolean
  instructions: string
  /** 用到这个角色的 workflow 节点；harness 列的是节点上自己写了 harness 的（会覆盖角色）。 */
  usedBy: Array<{ workflowId: string; workflowTitle?: string; nodeId: string; harness?: HarnessSelector }>
  /** 档案里引用了但空间里不存在的技能 / 知识库 / 模型，给出人能读的提示。 */
  problems?: string[]
}

/** 角色写入：给了的字段整体替换，null 删除该字段（回到下一层的默认）；instructions 不给则正文不动。 */
export interface AgentRoleWrite {
  baseRevision?: string
  reason: string
  title?: string
  description?: string
  harness?: HarnessSelector | null
  skills?: string[]
  knowledge?: string[] | null
  writeScope?: string[]
  readScope?: string[] | null
  allowBash?: boolean | null
  instructions?: string
}

// ------------------------------------------------------------ 自动化与通知渠道（docs/design/30 §4）

export interface AutomationsView {
  automations: AutomationView[]
  channels: ChannelView[]
  /** 本机时区（定时触发按它算）。 */
  timezone: string
}

export interface AutomationView extends AutomationConfig {
  /** 定时触发的下一次时间；停用或事件触发时为空。 */
  nextAt?: string
  lastRun?: AutomationRunRecord
  /** 引用的渠道 / workflow 不存在、cron 写错等，给出人能读的提示；有问题的自动化不会执行。 */
  problems?: string[]
}

export interface ChannelView extends ChannelConfig {
  /** urlEnv（和 secretEnv）现在从哪来；missing 时发不出去。不返回值。 */
  url: SecretSource
  secret?: SecretSource
  /** 被哪些自动化引用。 */
  usedBy: string[]
}

export interface AutomationRunRecord {
  id: string
  automationId: string
  at: string
  trigger: 'schedule' | 'event' | 'manual' | 'retry'
  /** 事件触发时的事件；重试时沿用原记录的。 */
  event?: { type: AutomationEvent; runId?: string; requirementId?: string; nodeId?: string }
  status: 'running' | 'ok' | 'failed' | 'skipped'
  /** 一句话结果，例如"已启动 run-xxx"、"已推送 3 个需求的进展"。 */
  summary: string
  error?: string
  /** start_workflow 启动的运行。 */
  runId?: string
  /** 发出去的消息正文（纯文本，便于在界面上预览）。 */
  text?: string
  deliveries: AutomationDelivery[]
  /** 重试的是哪条记录。 */
  retryOf?: string
  durationMs?: number
}

export interface AutomationDelivery {
  channel: string
  ok: boolean
  /** 对方返回的 HTTP 状态。 */
  status?: number
  error?: string
  at: string
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

/** 新建需求对话框里的草稿路由预估：还没有需求 id。 */
export interface RoutePreviewDraftRequest {
  /** 草稿全文（第一行是标题）。 */
  text: string
  repos?: string[]
  hint?: string
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
  source: 'builtin' | 'cli' | 'plugin' | 'native' | 'acp'
  available: boolean
  reason?: string
  capabilities: HarnessCapabilities
  /** 哪些角色默认用它。 */
  roles: string[]
  /** 实际启动的命令（含覆盖后的可执行文件路径）；native / mock 等进程内 harness 缺省。 */
  command?: string[]
  /** 本空间对它的覆盖（内置 harness）。 */
  override?: HarnessOverride
  /** 本空间自己加的（cli / acp），可以在设置页编辑和删除。 */
  custom?: boolean
}

export interface ModelInfo {
  alias: string
  provider: string
  protocol: ProviderProtocol
  /** provider 提供的全部协议（主协议 + endpoints），用来判断哪些 harness 能用这个模型。 */
  protocols?: ProviderProtocol[]
  id: string
  contextWindow?: number
  price?: { input: number; output: number }
  /** 对应的 apiKeyEnv 是否已设置（不返回值）。 */
  keyPresent: boolean
  kind?: 'chat' | 'embedding'
}

/** 设置页「模型与 Harness」的可编辑视图（docs/design/27 §4）：只含 takt.config.json 里运行时相关的几段。 */
export interface RuntimeConfig {
  /** 这几段内容的哈希；PATCH 时作为 baseRevision。 */
  revision: string
  providers: Record<string, ProviderConfig>
  models: Record<string, ModelConfig>
  /** 角色 → 默认 harness。 */
  roles: Record<string, HarnessSelector>
  /** 系统角色：lead（需求群）、route（路由判档）、steward（管家）、learner（经验提炼）。 */
  system: Partial<Record<RuntimeSystemRole, HarnessSelector>>
  /** 本空间自己加的 harness（声明式 CLI / ACP）。 */
  harnesses: Array<CliHarnessConfig | AcpHarnessConfig>
  harnessOverrides: Record<string, HarnessOverride>
  /** 各 provider 用到的 apiKeyEnv 现在从哪来（不返回值）。 */
  keys: Record<string, SecretSource>
  presets: { providers: ProviderPresetInfo[]; acp: AcpPresetInfo[] }
}

export type RuntimeSystemRole = 'lead' | 'route' | 'steward' | 'learner'
/** env：serve 进程的环境变量；local：本机密钥库；missing：都没有。环境变量优先。 */
export type SecretSource = 'env' | 'local' | 'missing'

/** 按段打补丁：给了的键整体替换该项，值为 null 删除该项；没给的段不动。 */
export interface RuntimeConfigPatch {
  baseRevision: string
  reason: string
  providers?: Record<string, ProviderConfig | null>
  models?: Record<string, ModelConfig | null>
  roles?: Record<string, HarnessSelector | null>
  system?: Partial<Record<RuntimeSystemRole, HarnessSelector | null>>
  /** 键为 harness id。 */
  harnesses?: Record<string, CliHarnessConfig | AcpHarnessConfig | null>
  harnessOverrides?: Record<string, HarnessOverride | null>
}

export interface RuntimeTestRequest {
  target: { kind: 'provider'; id: string } | { kind: 'model'; alias: string } | { kind: 'harness'; id: string }
  /** model 测试要真的发一次最小请求（会计费），必须显式同意。 */
  allowBilled?: boolean
}

export interface RuntimeTestResult {
  ok: boolean
  /** 一句话结论，给人看。 */
  message: string
  latencyMs?: number
  /** 细节：provider 列出的模型数、harness 的版本 / ACP 协议版本与 agent 能力等。 */
  detail?: string
  /** 这次测试是否产生了计费调用。 */
  billed: boolean
}

export interface ProviderPresetInfo {
  id: string
  displayName: string
  protocol: ProviderProtocol
  baseURL?: string
  /** 建议的环境变量名。 */
  apiKeyEnv?: string
  /** 同一把密钥能走的其他协议入口。 */
  endpoints?: Partial<Record<ProviderProtocol, string>>
}

export interface AcpPresetInfo {
  id: string
  displayName: string
  command: string[]
  /** 怎么装（一句话或命令），不可用时给人看。 */
  install?: string
}

export interface SecretStatus {
  name: string
  source: SecretSource
}

export type { AttentionItem, Lesson, QualityMetrics, RequirementMetrics, RouteDecision }

export interface Viewer {
  id: string
  name: string
  /** 对应的空间成员（含权限角色与职责）；未登记时缺省。 */
  member?: SpaceMember
}

export type RepoUpdateRequest = Partial<Omit<RepoBinding, 'id'>> & { reason?: string }

// ------------------------------------------------------------ 评测与归因（docs/design/20）

/** 节点 / 配方 / 技能的成绩单（全部从事件与产物计算）。 */
export interface NodeScorecard {
  key: { by: 'node' | 'recipe' | 'skill'; workflowId?: string; nodeId?: string; recipeKey?: string; skill?: { name: string; hash?: string } }
  label: string
  role?: string
  executions: number
  /** 第一次执行就成功且完成标准全部满足的比例。 */
  firstPassRate?: number
  review: { roundsAvg?: number; reworks: number; issues: { blocker: number; major: number; minor: number; nit: number } }
  humanEdits: { cosmetic: number; semantic: number; rate?: number }
  completionUnmet: number
  suppressed: number
  /** 沿溯源归到该节点的下游判决。 */
  downstream: Partial<Record<VerdictCategory, number>>
  /** 已确认归因为在该节点引入的逃逸缺陷数（漏检计入 detection.missed，不计入这里）。 */
  escapes: number
  /** 检出率：拦下 ÷（拦下 + 确认漏检）。评审 / 门禁节点都有；其他节点被确认漏检时只有 missed。 */
  detection?: { caught: number; missed: number; rate?: number }
  usage: Usage
  durationMsAvg?: number
  /** 按配方的时间序列（最早出现时间升序）。 */
  trend?: Array<{ recipeKey: string; firstAt: string; executions: number; firstPassRate?: number }>
  regression?: { suspected: boolean; reason?: string }
}

export interface EvalCollectRequest {
  target?: EvalTarget
  /** 只从这些运行里收集；缺省为全部历史。 */
  runIds?: string[]
  /** 同时把已确认缺陷生成回归用例。 */
  includeDefects?: boolean
  reason?: string
}

export interface EvalRunRequest {
  target: EvalTarget
  /** 第一个为基线；不给 baseline 时自动加一个"当前配方"的基线。 */
  variants: EvalVariant[]
  caseIds?: string[]
  /** 判分用的模型（rubric / 参考对比）；缺省用 evaluator 角色的默认 harness。 */
  judge?: HarnessSelector
  reason?: string
  /** 每个样本每个变体重复次数（缺省 TaktConfig.eval.repeats，再缺省 3）。 */
  repeats?: number
}

export interface DefectDetail extends Defect {
  attribution?: DefectAttribution
  /** 归因任务进行中。 */
  attributing?: boolean
  /** 创建它的观察（展开后的）。 */
  observationsDetail?: Observation[]
}

export interface DefectUpdateRequest {
  validity?: Defect['validity']
  resolution?: Defect['resolution']
  duplicateOf?: string
  baseRevision: number
  reason: string
}

export interface MissDecisionRequest {
  verdict: MissVerdict
  conditions?: MissAssessment['conditions']
  note?: string
  /** 改判原因（进质量日志）；baseRevision 为读到的缺陷 revision，不一致返回 409。 */
  reason: string
  baseRevision?: number
}

export interface EvalSampleRequest {
  kind: 'must_catch' | 'clean'
  checkpointId: string
  /** must_catch：期望提出的问题（缺陷标题或问题键）。 */
  expectIssue?: string
  defectId?: string
  /** must_catch：读到的缺陷 revision；缺陷之后被改过返回 409。 */
  baseRevision?: number
  reason: string
}

export interface DefectReportRequest {
  /** 从这些观察创建（可多选）；直接录入外部问题时不给。 */
  observations?: string[]
  title: string
  description: string
  severity: Defect['severity']
  acs?: string[]
  links?: Defect['links']
  evidence?: string[]
  reason?: string
}

export interface DefectConfirmRequest {
  /** 人对归因的修改（缺省表示原样确认）。 */
  attribution?: Partial<Pick<DefectAttribution, 'introducedAt' | 'missedBy' | 'suggestions'>>
  note?: string
}

export type { Defect, DefectAttribution, EvalCase, EvalRun, NodeRecipe }
export type { Checkpoint, DefectMergeSuggestion, EvalGate, EvalReport, Invocation, MissAssessment, MissVerdict, Observation, ReviewIssueEntry, SnapshotManifest }
export type { QualityStatus } from './interfaces.js'


// ------------------------------------------------------------ 需求与空间增删改（docs/design/22）

export interface ServerInfo {
  version: string
  /** 以 --spaces 启动时为 true，才能新建空间。 */
  multiSpace: boolean
  /** 单空间模式下切到多空间的建议启动命令（页面说明用）。 */
  multiSpaceHint?: string
  steward: { configured: boolean; harness?: string; model?: string; reason?: string }
  /** 可用的空间起点模板。 */
  spaceTemplates: Array<{ id: 'blank' | 'standard' | 'quick'; title: string; description: string }>
}

export interface RequirementCreateRequest {
  title: string
  /** 背景、目标、验收标准；写入 inputs/prd.md。 */
  description?: string
  id?: RequirementId
  owner?: string
  members?: string[]
  links?: ExternalLink[]
  dueAt?: string
  /** 不填按路由（RouteDecision）选流程。 */
  workflowId?: string
  /** 创建后立即启动（默认 true）。 */
  start?: boolean
  repos?: string[]
  budget?: RunBudget
  /** 附件写入 inputs/<name>；文本用 utf8，二进制用 base64。 */
  attachments?: Array<{ name: string; content: string; encoding?: 'utf8' | 'base64' }>
  reason?: string
}

export interface RequirementCreateResponse {
  requirement: RequirementSummary
  route?: RouteDecision
  /** start 为 true 且启动成功时。 */
  runId?: RunId
  /** 启动失败时的原因（需求已创建）。 */
  startError?: string
}

export interface RequirementUpdateRequest {
  title?: string
  description?: string
  owner?: string
  members?: string[]
  links?: ExternalLink[]
  /** null 清除。 */
  dueAt?: string | null
  reason: string
}

export type SpaceTemplate = 'blank' | 'standard' | 'quick' | { copyFrom: string; parts: Array<'agents' | 'skills' | 'workflows' | 'knowledge' | 'models' | 'members'> }

export interface SpaceCreateRequest {
  /** 目录名，^[a-z0-9][a-z0-9-]{1,39}$。 */
  id: string
  name: string
  description?: string
  color?: string
  template: SpaceTemplate
  repos?: Array<{ id?: string; path?: string; url?: string; defaultBranch?: string }>
  members?: SpaceMember[]
  reason?: string
}

export interface SpaceUpdateRequest {
  name?: string
  description?: string
  color?: string
  reason: string
}

export interface WorkflowConvertRequest {
  dryRun?: boolean
  /** 调用方看到的修订；与当前不一致时 409。 */
  baseRev?: string
  reason?: string
}

export interface WorkflowConvertResult {
  ok: boolean
  /** ok 为 false 时：确定性改写做不了的原因（可交给管家出提案）。 */
  reason?: string
  source?: string
  diff?: string
  /** dryRun 为 false 且成功时：写入后的文档。 */
  document?: WorkflowDocument
}

// ------------------------------------------------------------ 管家（docs/design/22）

export type StewardContextRef = {
  type: 'space' | 'requirement' | 'run' | 'node' | 'workflow' | 'knowledge' | 'file'
  spaceId?: string
  id: string
  /** node 所在的运行 / workflow。 */
  parent?: string
  label?: string
}

export interface StewardThread {
  id: string
  title: string
  createdAt: string
  updatedAt: string
  context?: StewardContextRef[]
  lastMessage?: string
  /** 有待决定的提案数。 */
  pendingProposals?: number
  /** docs/design/30 §2。置顶时间；排序时置顶的在前。 */
  pinnedAt?: string
  archivedAt?: string
  /** 用户改过标题后不再按首条消息自动起名。 */
  titleEdited?: boolean
  /** 这个会话固定用的 harness / 模型（模型为别名）；缺省跟随管家偏好与空间默认。 */
  runtime?: StewardRuntime
  /** 回复状态：replying 正在回复；error 上次回复失败（error 里是可读原因）；interrupted 服务重启或取消导致没回完。 */
  status?: 'replying' | 'error' | 'interrupted'
  error?: string
  messageCount?: number
  /** 会话最常提到的空间 / 需求（取 context 与消息里的引用），供按空间 / 需求分组。 */
  spaceId?: string
  requirementId?: RequirementId
  requirementTitle?: string
}

/** 管家用哪个 harness 跑、用哪个模型。harness 缺省为 native（直连模型 API）。 */
export interface StewardRuntime {
  harness?: string
  model?: string
}

export interface StewardThreadPatch {
  title?: string
  pinned?: boolean
  archived?: boolean
  /** null 表示清掉，回到默认。 */
  runtime?: StewardRuntime | null
}

/** 管家可选的一个 harness × 模型组合（docs/design/30 §2）。 */
export interface StewardRuntimeChoice {
  harness: string
  harnessLabel: string
  /** 模型别名（models 里的 key）；harness 自带模型时为空。 */
  model?: string
  modelLabel?: string
  provider?: string
  /** 来自哪个空间的配置（多空间时同名模型以默认空间为准）。 */
  spaceId?: string
  available: boolean
  reason?: string
  /** 当前默认（偏好或空间配置）。 */
  isDefault?: boolean
}

export interface StewardToolCall {
  id: string
  tool: string
  input: Record<string, unknown>
  ok?: boolean
  /** 一句话：查了什么、返回几条。 */
  summary?: string
  ms?: number
  /** 原始结果（截断到 20KB）。 */
  output?: unknown
}

export interface StewardCitation {
  /** 正文里用 [n] 引用，n 为数组下标 + 1。 */
  label: string
  /** 站内路由，例如 /s/shop/requirements/REQ-002?tab=runs#node=test。 */
  href: string
  kind?: StewardContextRef['type'] | 'event' | 'attention' | 'risk'
}

export interface StewardDelegation {
  spaceId: string
  requirementId: RequirementId
  /** 群聊里管家发出的那条消息。 */
  messageId: string
  /** M5 起用 DelegationStatus（docs/design/26 §4）；answered / failed 为旧数据，读时分别按 replied / uncertain 显示。 */
  status: DelegationStatus | 'answered' | 'failed'
  reply?: string
  at: string
}

export interface StewardMessage {
  id: string
  threadId: string
  role: 'user' | 'steward' | 'system'
  at: string
  author?: Actor
  /** markdown；引用写成 [1] [2]。 */
  text: string
  /** 思考摘要（默认折叠）。 */
  thinking?: string
  tools?: StewardToolCall[]
  citations?: StewardCitation[]
  proposalIds?: string[]
  suggestions?: string[]
  delegations?: StewardDelegation[]
  context?: StewardContextRef[]
  feedback?: { rating: 'up' | 'down'; reason?: 'wrong' | 'missed' | 'verbose' | 'bad_action' | (string & {}); at: string }
  status?: 'streaming' | 'done' | 'error'
  error?: string
  /** 未配置模型时的规则回复。 */
  offline?: boolean
  /** 可视化块（生成式界面，docs/design/24）：显示在正文之后；正文只留结论与解释。 */
  blocks?: StewardBlock[]
}

/** 管家回答里的状态语气：与界面状态色一一对应。 */
export type StewardTone = 'neutral' | 'success' | 'running' | 'waiting' | 'failed' | 'stale'
/** 进度泳道上一格的状态。 */
export type StewardStageStatus = 'done' | 'running' | 'waiting' | 'failed' | 'todo' | 'skipped'

/**
 * 按钮：只做"追问 / 跳转 / 打开预填的命令表单"三件事，写操作仍走命令表单或提案，按钮本身不执行。
 */
export type StewardAction =
  | { kind: 'ask'; label: string; text: string; primary?: boolean }
  | { kind: 'open'; label: string; ref: StewardContextRef; primary?: boolean }
  | { kind: 'command'; label: string; commandId: string; input?: Record<string, unknown>; primary?: boolean }

/**
 * 管家的可视化块（一条消息最多 6 块，不嵌套）。模型用 show 工具给出，服务端 steward/blocks.ts 校验并修正：
 * 超出上限截断、未知 tone / status 归一、ref 必须是调用者看得见的对象（看不见的去掉 ref 保留文字）、command 必须在命令表里。
 * 上限：stats 6 项；lanes 12 行 × 12 格；bars 12 项；table 8 列 × 20 行；checklist 12 项；timeline 12 项；actions 4 个；
 * 文本：label ≤ 40 字、title ≤ 60 字、单元格 ≤ 80 字、callout.body ≤ 240 字。
 */
export type StewardBlock =
  | { type: 'stats'; title?: string; items: Array<{ label: string; value: string | number; unit?: string; tone?: StewardTone; hint?: string; ref?: StewardContextRef }> }
  | { type: 'lanes'; title?: string; rows: Array<{ title: string; ref?: StewardContextRef; stages: Array<{ label: string; status: StewardStageStatus }>; note?: string; tone?: StewardTone }> }
  | { type: 'bars'; title?: string; unit?: string; items: Array<{ label: string; value: number; max?: number; tone?: StewardTone; hint?: string; ref?: StewardContextRef }> }
  | { type: 'table'; title?: string; columns: Array<{ key: string; label: string; align?: 'start' | 'end'; mono?: boolean }>; rows: Array<Record<string, string | number | null>>; refs?: Array<StewardContextRef | null> }
  | { type: 'checklist'; title?: string; items: Array<{ label: string; done: boolean; hint?: string; ref?: StewardContextRef }> }
  | { type: 'timeline'; title?: string; items: Array<{ at: string; title: string; detail?: string; tone?: StewardTone; ref?: StewardContextRef }> }
  | { type: 'callout'; tone: StewardTone; title: string; body?: string }
  | { type: 'actions'; items: StewardAction[] }
  /**
   * 实时实体视图（docs/design/28 §2）：模型只给 view + ref，服务端校验 ref 看得见、补齐 spaceId、从存储写 snapshot（模型写的 snapshot 一律丢弃）。
   * 前端按 ref 取实时数据、用页面上同一套组件渲染；取不到时显示 snapshot。一条消息最多 3 个 entity 块。
   * 引用：card / stages 为需求；attention 为需求或空间；dag 为运行（focus 为要高亮的节点 id）；node 为节点（parent 为运行 id）。
   */
  | { type: 'entity'; view: StewardEntityView; ref: StewardContextRef; focus?: string; snapshot: StewardEntitySnapshot }
  /** 说的是哪一个？候选 2–5 个，点一个就带着它继续问（docs/design/28 §3）。一条消息最多 1 个。 */
  | { type: 'pick'; title?: string; items: StewardEntityCandidate[] }

/** 实体视图（P1）：需求卡、阶段、运行图、节点、等你决定的事。 */
export type StewardEntityView = 'card' | 'stages' | 'dag' | 'node' | 'attention'

/** 服务端出块那一刻从存储读出的样子：离线、历史消息、没权限或对象已删除时显示它；前端拿实时数据比较给"比当时"标记。 */
export interface StewardEntitySnapshot {
  title: string
  /** 人话状态，例如"研发测试 · 失败判决在跑"。 */
  status: string
  tone: StewardTone
  /** 一句补充，例如"1 件等你确认"。 */
  summary?: string
  /** 阶段格（需求 / 运行）：离线与历史消息里画泳道用。 */
  stages?: Array<{ label: string; status: StewardStageStatus }>
  at: string
}

export interface StewardEntityCandidate {
  /** 带 spaceId。 */
  ref: StewardContextRef
  snapshot: StewardEntitySnapshot
  /** 为什么是它：例如"编号命中"、"标题含「导出」"、"10 分钟前有动静"。 */
  why?: string
}

export type StewardFindType = 'space' | 'requirement' | 'run' | 'node' | 'workflow' | 'knowledge'

export interface StewardFindResult {
  items: Array<StewardEntityCandidate & { score: number; match: 'id' | 'title' | 'recent' }>
  /** 前两名分差小：调用方应出 pick 让人选，不要猜。 */
  ambiguous: boolean
}

/** Solo 首页"你可能想看"的一张需求卡。 */
export interface StewardPick extends StewardEntityCandidate {
  reason: 'waiting' | 'failed' | 'risk' | 'changed' | 'running'
}

export interface StewardPostRequest {
  text: string
  context?: StewardContextRef[]
  /** 附件（文本）：作为消息上下文，不落盘。 */
  attachments?: Array<{ name: string; content: string }>
}

export type StewardStreamEvent =
  | { type: 'message'; message: StewardMessage }
  | { type: 'delta'; messageId: string; text: string }
  | { type: 'thinking'; messageId: string; text: string }
  | { type: 'tool'; messageId: string; tool: StewardToolCall }
  /** 本条消息的全部可视化块（每次给全量，前端直接替换）。 */
  | { type: 'blocks'; messageId: string; blocks: StewardBlock[] }
  | { type: 'proposal'; proposal: Proposal }
  | { type: 'delegation'; messageId: string; delegation: StewardDelegation }
  | { type: 'done'; messageId: string }
  | { type: 'error'; messageId: string; error: string }

export type ProposalStep =
  | { kind: 'command'; spaceId?: string; commandId: string; input: Record<string, unknown>; title?: string }
  | { kind: 'workflow'; spaceId?: string; workflowId: string; baseRev: string; edits: WorkflowEdit[]; title?: string }
  /** 只限空间内文件（角色档案、技能、知识库配置、wiki 页等），经带审计的写入口落盘。 */
  | { kind: 'file'; spaceId?: string; path: string; baseHash?: string; content: string; title?: string }

export interface Proposal {
  id: string
  threadId: string
  title: string
  summary: string
  risk: 'low' | 'medium' | 'high'
  steps: ProposalStep[]
  /** steps 规范化 JSON 的 sha256；批准时必须带上。 */
  hash: string
  status: 'pending' | 'applied' | 'rejected' | 'failed' | 'reverted' | 'stale'
  createdAt: string
  createdBy: Actor
  decidedBy?: Actor
  decidedAt?: string
  reason?: string
  /** 人在批准前改过内容。 */
  edited?: boolean
  /** 低风险自动执行（信任档位 auto-low）。 */
  auto?: boolean
  /** 每步执行结果。 */
  results?: Array<{ ok: boolean; message: string; result?: unknown }>
  /** 可撤销的截止时间；过期或目标被他人改过后不可撤销。 */
  undoUntil?: string
  /** 预览：workflow 步骤的统一 diff、文件 diff、命令的人话摘要（与 steps 一一对应）。 */
  previews?: Array<{ kind: 'diff' | 'form' | 'text'; title: string; body: string }>
  error?: string
}

export interface ProposalDecisionRequest {
  hash: string
  reason?: string
  /** 人在批准前修改过的步骤（整体替换；服务端重算 hash 并标 edited）。 */
  steps?: ProposalStep[]
  /** 删除类 / 高风险提案：人手输入的目标 id 或名称，服务端核对一致才执行。 */
  confirm?: string
}

export type RiskKind = 'waiting-human' | 'budget' | 'stalled' | 'repeat-failure' | 'review-stuck' | 'gate-failed' | 'deadline' | 'defect-escape' | 'regression' | 'knowledge'

export interface RiskAction {
  label: string
  /** 直接执行的命令（仍走提案）。 */
  commandId?: string
  input?: Record<string, unknown>
  /** 跳转。 */
  href?: string
  /** 交给管家："帮我……"。 */
  ask?: string
}

export interface Risk {
  /** `<kind>:<space>/<requirement>/<subject>`，用来去重。 */
  key: string
  kind: RiskKind
  level: 'medium' | 'high'
  spaceId: string
  requirementId?: RequirementId
  runId?: RunId
  nodeId?: NodeId
  title: string
  detail: string
  evidence: Array<{ label: string; href: string }>
  firstSeenAt: string
  lastSeenAt: string
  actions: RiskAction[]
  state: 'open' | 'snoozed' | 'ignored' | 'resolved'
  snoozedUntil?: string
  /** 最近一次提醒时的级别（升级才再提醒）。 */
  notifiedLevel?: 'medium' | 'high'
}

export interface RiskStateRequest {
  state: 'open' | 'snoozed' | 'ignored'
  until?: string
  reason?: string
}

export interface Digest {
  id: string
  at: string
  since?: string
  /** 两句话摘要；未配置模型时由规则生成。 */
  summary: string
  attention: Array<{ spaceId: string; requirementId: RequirementId; requirementTitle: string; requestId: string; ask: string; since: string; href: string }>
  risks: Risk[]
  /** 每个需求只留最新一条（docs/design/30 §2）；more 是同一需求被折叠掉的更早条数。 */
  progress: Array<{ spaceId: string; requirementId: RequirementId; title: string; kind: 'created' | 'started' | 'stage' | 'delivered' | 'failed' | 'blocked'; from?: string; to?: string; at: string; href: string; more?: number }>
  metrics?: Array<{ spaceId: string; label: string; value: string; delta?: string }>
}

export type StewardFeedItem =
  | { type: 'digest'; at: string; digest: Digest }
  | { type: 'risk'; at: string; risk: Risk; change: 'new' | 'escalated' | 'resolved' }
  | { type: 'proposal'; at: string; proposal: Proposal }
  | { type: 'delegation'; at: string; threadId: string; delegation: StewardDelegation }
  | { type: 'unread'; at: string; count: number }

export interface StewardPrefs {
  /** confirm：每次确认（默认）；auto-low：低风险且可撤销的提案自动执行。 */
  trust: 'confirm' | 'auto-low'
  /** 定时汇报，'HH:MM'，工作日。 */
  digestTimes: string[]
  quietHours?: { from: string; to: string }
  watchedSpaces?: string[]
  mutedSpaces?: string[]
  /** 新建需求未指定空间时建在这里。 */
  defaultSpace?: string
  harness?: HarnessSelector
  browserNotifications?: boolean
}

/** 页面上报的交互事件，只记录在本机 .steward/<user>/metrics.jsonl，用于 ProductMetric 统计。 */
export interface ProductEvent {
  type: 'dialog.open' | 'dialog.submit' | 'dialog.cancel' | 'suggestion.click' | 'digest.open' | 'digest.click' | 'risk.action' | 'palette.ask'
  /** 例如 requirement.create、space.create、knowledge.create。 */
  feature: string
  spaceId?: string
  /** dialog.submit：从打开到提交的毫秒数。 */
  ms?: number
  detail?: Record<string, string | number | boolean>
}

export interface ProductMetric {
  feature: 'requirement.create' | 'steward.answer' | 'steward.proposal' | 'steward.digest' | 'workflow.edit' | 'space.create' | 'knowledge' | (string & {})
  metric: string
  value: number
  unit?: '%' | 'ms' | 's' | 'count' | (string & {})
  /** 统计窗口，例如 7d。 */
  window: string
  /** 最近 7 个点（按天）。 */
  trend?: number[]
  /** 迭代信号：这个数说明该改什么。 */
  hint?: string
}

// ------------------------------------------------------------ 知识库（docs/design/23）

export interface KnowledgeKindInfo {
  kind: string
  title: string
  summary: string
  example?: string
  intents: KnowledgeIntent[]
  configSchema: Record<string, unknown>
  needsBuild: boolean
  available: boolean
  reason?: string
}

export interface KnowledgeBaseSummary extends KnowledgeBase {
  /** 本空间是否已绑定。 */
  bound: boolean
  usage7d: { queries: number; hitRate: number; citedRate: number; emptyRate: number }
  lastEval?: { runId: string; recall10: number; at: string }
  /** 构建之后源又变了的文档数。 */
  staleDocs?: number
  building?: { buildId: string; stage: string; done: number; total: number }
}

export interface KnowledgeDoc {
  path: string
  bytes: number
  updatedAt: string
  indexed: boolean
}

export interface KnowledgeEvalSet {
  id: string
  title: string
  cases: KnowledgeEvalCase[]
}

export interface KnowledgeBaseDetail extends KnowledgeBaseSummary {
  bindings: Array<KnowledgeBinding & { spaceId: string }>
  builds: KnowledgeBuild[]
  evalSets: Array<{ id: string; title: string; total: number; bySource: Partial<Record<KnowledgeEvalCase['source'], number>>; candidates: number }>
  usage: {
    byNode: Array<{ workflowId: string; nodeId: string; queries: number; citedRate: number }>
    recent: Array<{ at: string; requirementId?: RequirementId; runId?: RunId; nodeId?: NodeId; query: string; hits: number; cited: boolean; latencyMs: number; via?: KnowledgeCaller['via'] }>
    trend: Array<{ date: string; queries: number; hitRate: number; emptyRate: number; citedRate: number }>
  }
}

export interface KnowledgeCreateRequest {
  id?: string
  name: string
  kind: string
  description?: string
  intents?: KnowledgeIntent[]
  scope?: 'space' | 'shared'
  config: Record<string, unknown>
  retrieval?: Partial<KnowledgeRetrieval>
  /** 创建后立即绑定到当前空间（默认 true）。 */
  bind?: boolean
  reason?: string
}

export interface KnowledgeUpdateRequest {
  name?: string
  description?: string
  intents?: KnowledgeIntent[]
  config?: Record<string, unknown>
  retrieval?: Partial<KnowledgeRetrieval>
  reason: string
}

export interface KnowledgeTestResult {
  ok: boolean
  message: string
  preview?: Array<{ title: string; ref: string; snippet: string }>
}

export interface KnowledgeUploadRequest {
  files: Array<{ path: string; content: string; encoding?: 'utf8' | 'base64' }>
}

export interface KnowledgeQueryRequest {
  text: string
  intent?: KnowledgeIntent
  topK?: number
  version?: 'candidate' | 'published'
  retrieval?: Partial<KnowledgeRetrieval>
}

export interface KnowledgeQueryResponse {
  hits: Array<KnowledgeHit & { content?: string }>
  latencyMs: number
  tokens: number
  intent: KnowledgeIntent
  /** database / api：实际执行的 SQL 或调用（检索测试页展示）。 */
  executed?: { kind: 'sql' | 'http'; text: string; blocked?: string }
}

export interface KnowledgePublishRequest {
  version?: number
  reason: string
  force?: boolean
}

export interface KnowledgePublishResponse {
  base: KnowledgeBaseSummary
  gate: { pass: boolean; reasons: string[]; evalRunId?: string }
}

export interface KnowledgeEvalRunRequest {
  setId: string
  variants: KnowledgeEvalVariant[]
}

export interface KnowledgeMigration {
  /** 每个旧条目的迁移结果。 */
  items: Array<{ id: string; kind: string; to?: string; ok: boolean; message: string }>
  applied: boolean
}

export type { KnowledgeBase, KnowledgeBinding, KnowledgeBuild, KnowledgeEvalCase, KnowledgeEvalRun }
