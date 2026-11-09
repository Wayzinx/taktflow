import type {
  Digest,
  KnowledgeBaseDetail,
  KnowledgeBaseSummary,
  KnowledgeBinding,
  KnowledgeBuild,
  KnowledgeCreateRequest,
  KnowledgeDoc,
  KnowledgeEvalCase,
  KnowledgeEvalRun,
  KnowledgeEvalRunRequest,
  KnowledgeEvalSet,
  KnowledgeKindInfo,
  KnowledgeMigration,
  KnowledgePublishRequest,
  KnowledgePublishResponse,
  KnowledgeQueryRequest,
  KnowledgeQueryResponse,
  KnowledgeTestResult,
  KnowledgeUpdateRequest,
  KnowledgeUploadRequest,
  ProductEvent,
  ProductMetric,
  Proposal,
  ProposalDecisionRequest,
  RequirementCreateRequest,
  RouteDecision,
  RoutePreviewDraftRequest,
  RequirementCreateResponse,
  RequirementSummary,
  RequirementUpdateRequest,
  Risk,
  RiskStateRequest,
  ServerInfo,
  SpaceCreateRequest,
  SpaceSummary,
  SpaceUpdateRequest,
  StewardFeedItem,
  StewardMessage,
  StewardPostRequest,
  StewardPrefs,
  StewardStreamEvent,
  StewardThread,
  StewardFindResult,
  StewardFindType,
  StewardPick,
  WorkflowConvertResult,
} from '@taktflow/core'

/**
 * M4 新增接口（packages/core/src/api.ts 的三节：需求与空间增删改、管家、知识库）。
 * DataSource（source.ts）继承这三组；HTTP 客户端（client.ts）与演示数据（mock-crud / mock-steward / mock-knowledge）实现同一份。
 * 前缀：管家（/steward/*）、空间列表与增删改（/spaces*）、/server 是全局接口，不加 /s/:spaceId；其余作用于当前空间。
 */

export interface CrudSource {
  /** GET /server：多空间模式、管家是否已配置模型、空间起点模板。 */
  serverInfo(): Promise<ServerInfo>
  /** POST /route/preview：草稿还没有需求 id 时，用服务端路由器预估档位与流程（与不指定流程创建时一致）。 */
  routePreviewDraft(body: RoutePreviewDraftRequest): Promise<RouteDecision>
  /** POST /requirements：start 为 true 时同时启动（失败时 startError，需求仍已创建）。 */
  createRequirement(body: RequirementCreateRequest): Promise<RequirementCreateResponse>
  updateRequirement(id: string, body: RequirementUpdateRequest): Promise<RequirementSummary>
  /** 有运行中的运行时 409。 */
  archiveRequirement(id: string, reason: string): Promise<RequirementSummary>
  restoreRequirement(id: string, reason: string): Promise<RequirementSummary>
  /** 只允许没有任何运行记录的需求，否则 409。 */
  deleteRequirement(id: string, reason: string): Promise<void>
  /** POST /spaces：单空间模式 409；id / 名称重复 409。 */
  createSpace(body: SpaceCreateRequest): Promise<SpaceSummary>
  updateSpace(id: string, body: SpaceUpdateRequest): Promise<SpaceSummary>
  /** 有运行中的需求时 409。 */
  archiveSpace(id: string, reason: string): Promise<SpaceSummary>
  restoreSpace(id: string, reason: string): Promise<SpaceSummary>
  /** 只允许已归档的空间；confirm 必须等于 id。 */
  deleteSpace(id: string, body: { confirm: string; reason: string }): Promise<void>
  /** 把不可编辑写法改写为 defineWorkflow；dryRun 只返回 diff。 */
  convertWorkflow(id: string, body: { dryRun?: boolean; reason?: string; baseRev?: string }): Promise<WorkflowConvertResult>
}

export interface StewardThreadDetail {
  thread: StewardThread
  messages: StewardMessage[]
  proposals: Proposal[]
}

export interface StewardSource {
  stewardThreads(): Promise<StewardThread[]>
  /** 新会话 + 第一条消息；管家的回复走 subscribeSteward。 */
  createStewardThread(body: StewardPostRequest): Promise<{ thread: StewardThread; message: StewardMessage }>
  stewardThread(id: string): Promise<StewardThreadDetail>
  /** 用户消息；管家回复（thinking → tool → delta … → done）走 subscribeSteward。 */
  postStewardMessage(threadId: string, body: StewardPostRequest): Promise<StewardMessage>
  /** 会话的 SSE（StewardStreamEvent）；返回取消订阅函数。 */
  subscribeSteward(threadId: string, on: (e: StewardStreamEvent) => void): () => void
  stewardFeedback(messageId: string, body: { rating: 'up' | 'down'; reason?: string }): Promise<StewardMessage>
  proposals(status?: Proposal['status']): Promise<Proposal[]>
  /** hash 不一致或基线变了 409（状态 stale）。 */
  approveProposal(id: string, body: ProposalDecisionRequest): Promise<Proposal>
  rejectProposal(id: string, reason?: string): Promise<Proposal>
  undoProposal(id: string, reason?: string): Promise<Proposal>
  risks(opts?: { space?: string; state?: Risk['state'] }): Promise<Risk[]>
  setRiskState(key: string, body: RiskStateRequest): Promise<Risk>
  /** since 缺省为上次查看。 */
  /** peek：只读，不标已读（服务端默认会把"上次查看"推到此刻并记一次 digest.open）。 */
  digest(since?: string, opts?: { peek?: boolean }): Promise<Digest>
  /** "动态"：汇报、风险变化、提案结果、未读数。 */
  stewardFeed(): Promise<StewardFeedItem[]>
  /** 全局动态 SSE（含 type: 'unread'）。 */
  subscribeStewardFeed(on: (item: StewardFeedItem) => void): () => void
  stewardPrefs(): Promise<StewardPrefs>
  saveStewardPrefs(prefs: StewardPrefs): Promise<StewardPrefs>
  stewardProfile(): Promise<{ content: string }>
  saveStewardProfile(content: string): Promise<{ content: string }>
  /** 页内"让管家……"建议，最多 3 条；space 缺省为当前空间。 */
  stewardSuggestions(q: { page: string; space?: string; id?: string }): Promise<string[]>
  /** GET /steward/find：跨看得见的空间找需求 / 运行 / 节点 / workflow / 知识库（docs/design/28 §3）。 */
  stewardFind(q: string, opts?: { types?: StewardFindType[]; spaceId?: string; limit?: number }): Promise<StewardFindResult>
  /** GET /steward/picks：Solo 首页"你可能想看"。 */
  stewardPicks(limit?: number): Promise<StewardPick[]>
  /** 产品健康：每个功能的效率与迭代信号。 */
  productMetrics(): Promise<ProductMetric[]>
  /** 交互事件上报（只存本机）；失败不抛错。 */
  reportProductEvent(e: ProductEvent): Promise<void>
}

export interface KnowledgeSource {
  knowledgeKinds(): Promise<KnowledgeKindInfo[]>
  knowledgeBases(): Promise<KnowledgeBaseSummary[]>
  createKnowledgeBase(body: KnowledgeCreateRequest): Promise<KnowledgeBaseSummary>
  knowledgeBase(id: string): Promise<KnowledgeBaseDetail>
  updateKnowledgeBase(id: string, body: KnowledgeUpdateRequest): Promise<KnowledgeBaseSummary>
  deleteKnowledgeBase(id: string, reason: string): Promise<void>
  /** 测试连接 + 预览前几个文档 / 表 / 操作。 */
  testKnowledgeBase(id: string): Promise<KnowledgeTestResult>
  uploadKnowledge(id: string, body: KnowledgeUploadRequest): Promise<{ docs: number }>
  knowledgeDocs(id: string): Promise<KnowledgeDoc[]>
  /** 后台构建；进度走 subscribeKnowledgeBuild。 */
  startKnowledgeBuild(id: string, reason: string): Promise<KnowledgeBuild>
  knowledgeBuild(id: string, buildId: string): Promise<KnowledgeBuild>
  /** 构建进度 SSE（每条 data 为完整 KnowledgeBuild）；结束（succeeded / failed / cancelled）后自动停止。 */
  subscribeKnowledgeBuild(id: string, buildId: string, on: (b: KnowledgeBuild) => void): () => void
  cancelKnowledgeBuild(id: string, buildId: string): Promise<KnowledgeBuild>
  /** 检索测试（分项得分、database / api 实际执行的语句）。 */
  queryKnowledge(id: string, body: KnowledgeQueryRequest): Promise<KnowledgeQueryResponse>
  /** 门槛未过且未 force 时服务端 409，响应体同样是 KnowledgePublishResponse：这里不抛错，直接返回（gate.pass 为 false）。 */
  publishKnowledge(id: string, body: KnowledgePublishRequest): Promise<KnowledgePublishResponse>
  knowledgeEvalSets(id: string): Promise<KnowledgeEvalSet[]>
  /** 新增或按 id 更新用例（检索测试里的"相关 / 不相关"标注、候选用例确认）。 */
  saveKnowledgeEvalCases(id: string, setId: string, cases: KnowledgeEvalCase[]): Promise<KnowledgeEvalCase[]>
  synthesizeKnowledgeCases(id: string, setId: string, count: number): Promise<KnowledgeEvalCase[]>
  harvestKnowledgeCases(id: string, setId: string): Promise<KnowledgeEvalCase[]>
  knowledgeEvalRuns(id: string): Promise<KnowledgeEvalRun[]>
  /** 后台执行，轮询 knowledgeEvalRun 看进度。 */
  startKnowledgeEvalRun(id: string, body: KnowledgeEvalRunRequest): Promise<KnowledgeEvalRun>
  knowledgeEvalRun(id: string, runId: string): Promise<KnowledgeEvalRun>
  knowledgeBindings(): Promise<KnowledgeBinding[]>
  saveKnowledgeBindings(bindings: KnowledgeBinding[], reason: string): Promise<KnowledgeBinding[]>
  /** 只返回名字（只写不读）。 */
  knowledgeSecrets(): Promise<string[]>
  putKnowledgeSecret(name: string, value: string): Promise<{ name: string }>
  /** 旧 takt.config.json 的 knowledge 条目 → kb.json。 */
  migrateKnowledge(dryRun?: boolean): Promise<KnowledgeMigration>
}
