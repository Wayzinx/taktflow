/**
 * taktflow 核心契约。
 *
 * 所有包（engine / harness / knowledge / server / cli / web）都只依赖这里的类型互相协作。
 * 改这里等于改协议：先改 docs/design 里对应的设计文档，再改类型。
 */

// ============================================================ 通用

/** ISO 8601 时间字符串。 */
export type Timestamp = string

/** 需求 ID，例如 `REQ-001`。一个需求对应一个公共存放区（workspace）。 */
export type RequirementId = string
/** 运行 ID，例如 `run-20261104-0001`。 */
export type RunId = string
/** 节点 ID，在一个 workflow 内唯一；动态展开的节点为 `<plannerId>/<itemKey>/<childId>`。 */
export type NodeId = string

/** 谁做的事：人、某个角色的 agent、或系统本身。审计里的每一条记录都带 actor。 */
export type Actor =
  /** via：入口渠道（dsh-web / dsh:user-questions / cli / web 等）。 */
  | { type: 'human'; id: string; via?: string }
  /** onBehalfOf：agent 代表谁执行（例如 dsh 里的 Lead 会话）。 */
  | { type: 'agent'; role: string; harness: string; model?: string; onBehalfOf?: string }
  | { type: 'system'; id: string }

export interface Usage {
  inputTokens: number
  outputTokens: number
  cachedTokens?: number
  costUsd?: number
  /** harness 不报告用量时按字符估算的值。 */
  estimated?: boolean
}

// ============================================================ 需求与公共存放区

export type RequirementStatus = 'draft' | 'active' | 'blocked' | 'delivered' | 'archived'

export interface ExternalLink {
  /** meego / jira / feishu / github / url 等，开放字符串便于扩展。 */
  type: string
  url: string
  title?: string
}

export interface Requirement {
  id: RequirementId
  title: string
  status: RequirementStatus
  /** 当前所处阶段（StageDef.id），由最近一次运行推导。 */
  stage?: string
  owner?: string
  members?: string[]
  links: ExternalLink[]
  createdAt: Timestamp
  updatedAt: Timestamp
}

/**
 * 公共存放区里的产物类型。决定 Web 上的分类 Tab（Spec / 评审 / 外部文档 / 测试计划 / 测试报告 / 测试用例 …）。
 */
export type ArtifactKind =
  | 'input' // 原始物料：PRD、会议纪要、设计稿、外部文档链接
  | 'clarification' // 需求澄清问答
  | 'spec' // 规格（含验收标准 AC）
  | 'design' // 系分 / 技术方案
  | 'contract' // 接口契约、UI 契约
  | 'test-plan' // 测分 / 测试方案
  | 'case' // 测试用例
  | 'task' // 拆出来的开发任务
  | 'script' // 自动化脚本
  | 'code-change' // 代码改动摘要（commit / diff 引用）
  | 'evidence' // 执行证据
  | 'verdict' // 判决结果
  | 'review' // 评审意见
  | 'report' // 质量报告 / 准出报告
  | 'decision' // 决策记录（人工裁决、ADR）
  | 'knowledge' // 回流到知识库的条目
  | 'other'

/** 指向公共存放区里某个产物的某个版本；不写 version 表示最新版。 */
export interface ArtifactRef {
  workspace: RequirementId
  path: string
  version?: number
}

export interface ArtifactVersion {
  version: number
  sha256: string
  size: number
  createdAt: Timestamp
  author: Actor
  /** 人工修改时必须写原因；agent 产出时写节点目的。 */
  reason?: string
  /** 溯源：这个版本是基于哪些产物版本产出的。 */
  derivedFrom: ArtifactRef[]
  producedBy?: { runId: RunId; nodeId: NodeId }
}

export interface ArtifactRecord {
  /** 相对公共存放区根目录的路径，例如 `spec/spec.md`。 */
  path: string
  kind: ArtifactKind
  title?: string
  mediaType: string
  tags: string[]
  /** 内容里出现的追溯 ID（REQ-/AC-/TC- 等），用于构建追溯图。 */
  traceIds: string[]
  versions: ArtifactVersion[]
}

export interface ArtifactComment {
  id: string
  path: string
  version: number
  author: Actor
  body: string
  createdAt: Timestamp
  resolved?: boolean
}

// ============================================================ Workflow 定义（代码即流程）

/** 阶段：用于项目总览的阶段条（需求理解 → 系分 → 测分 → 研发测试 Loop → 影响面 → 质量报告）。 */
export interface StageDef {
  id: string
  title: string
}

export type NodeKind = 'script' | 'agent' | 'gate' | 'human' | 'judge' | 'loop' | 'planner' | 'review' | 'subflow'

/** 节点声明要读的产物：路径支持 glob；required=false 时缺失不阻塞。 */
export interface InputSpec {
  path: string
  kind?: ArtifactKind
  required?: boolean
}

/** 节点声明要产出的产物：节点结束后引擎按这里收集、记版本、写溯源；缺失必需产物即节点失败。 */
export interface OutputSpec {
  path: string
  kind: ArtifactKind
  required?: boolean
  /** 产物契约：JSON Schema（仅对 .json 产物生效）。 */
  schema?: Record<string, unknown>
}

/** 选哪个 harness 和模型；fallback 按顺序尝试。 */
export interface HarnessSelector {
  harness: string
  /** 模型：TaktConfig.models 里的别名，或 harness 认识的原始模型名。 */
  model?: string
  /** 把模型指到另一家 LLM API（TaktConfig.providers 的 id）；harness 必须声明 customProvider。 */
  provider?: string
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max'
  fallback?: HarnessSelector[]
}

/** 节点执行上下文：脚本节点和动态 prompt 拿到的东西。 */
export interface NodeContext {
  runId: RunId
  requirementId: RequirementId
  nodeId: NodeId
  /** 公共存放区在磁盘上的绝对路径（agent 直接读写这个目录）。 */
  workspaceDir: string
  /** 被管理项目的根目录。 */
  projectDir: string
  /** 循环节点内的第几轮（从 1 开始），非循环为 undefined。 */
  iteration?: number
  /** planner 展开出的条目，非展开节点为 undefined。 */
  item?: PlannedItem
  args: Record<string, unknown>
  /** 打回重做 / 重试时附带的意见（评审问题、上次失败原因），由引擎注入。 */
  feedback?: string
  /** 运行被取消时触发；脚本函数自己启动的子进程应监听它并结束。 */
  signal?: AbortSignal
  /** 读上游节点的结构化结果。 */
  resultOf(nodeId: NodeId): unknown
  /** 读公共存放区里某个产物的最新内容（文本）。 */
  readArtifact(path: string): Promise<string | undefined>
  log(message: string): void
}

export interface NodeResult {
  status?: 'succeeded' | 'failed' | 'blocked'
  /** 结构化结果，下游用 ctx.resultOf() 读取。 */
  data?: unknown
  message?: string
}

interface BaseNodeDef {
  id: NodeId
  kind: NodeKind
  title: string
  /** 所属阶段（StageDef.id）。 */
  stage?: string
  /** 依赖的上游节点。 */
  needs?: NodeId[]
  inputs?: InputSpec[]
  outputs?: OutputSpec[]
  /** 条件执行：返回 false 时节点记为 skipped。 */
  when?: (ctx: NodeContext) => boolean | Promise<boolean>
  retry?: { max: number }
  timeoutMs?: number
}

export interface ScriptNodeDef extends BaseNodeDef {
  kind: 'script'
  /** shell 命令（在 projectDir 下执行）或 TS 函数。确定性的事交给它。 */
  run: string | ((ctx: NodeContext) => Promise<NodeResult | void>)
}

export interface AgentNodeDef extends BaseNodeDef {
  kind: 'agent'
  /** 角色（AgentProfile.role），决定默认 harness、技能、读写范围。 */
  role: string
  prompt: string | ((ctx: NodeContext) => string | Promise<string>)
  /** 覆盖角色默认的 harness / 模型。 */
  harness?: HarnessSelector
  /** 写权限白名单（glob，相对 projectDir）。节点结束后引擎做 diff 校验，越界即 guard.violation。 */
  writeScope?: string[]
  /** 需要预先检索并注入的知识。 */
  knowledge?: KnowledgeQuery[]
  /** fresh：每次新会话（默认）；resume：续上一次同节点会话。 */
  session?: 'fresh' | 'resume'
  /** 让 agent 以 JSON 输出结构化结果。 */
  resultSchema?: Record<string, unknown>
  /** 在哪个绑定代码仓库里工作：引擎为节点创建独立 worktree 并作为 cwd。 */
  repo?: string
}

/** 门禁里的单项检查。fail-closed：检查本身出错按不通过处理。 */
export type GateCheck =
  | { id: string; kind: 'command'; run: string; title?: string }
  | { id: string; kind: 'function'; title?: string; fn: (ctx: NodeContext) => Promise<GateCheckResult> }
  | { id: string; kind: 'rubric'; title?: string; role: string; rubric: string; threshold: number }

export interface GateCheckResult {
  id: string
  pass: boolean
  /** 0–100，可选。 */
  score?: number
  message?: string
  details?: unknown
}

export interface GateNodeDef extends BaseNodeDef {
  kind: 'gate'
  checks: GateCheck[]
  /** 不通过时：停下（默认）/ 交人裁决。 */
  onFail?: 'stop' | 'human'
}

export interface HumanNodeDef extends BaseNodeDef {
  kind: 'human'
  /** 给人看的问题或待审内容说明。 */
  ask: string
  form: 'approve' | 'answer' | 'choice'
  choices?: string[]
}

/** 判决类别：执行失败的根因归属。 */
export type VerdictCategory =
  | 'product_bug' // 产品代码缺陷 → 开发
  | 'case_defect' // 用例本身错（预期写错、与需求矛盾）→ 测试设计
  | 'script_defect' // 脚本实现错（定位、等待、取值）→ 自动化
  | 'env_issue' // 环境 / 数据 / 依赖问题 → 执行底座
  | 'flaky' // 不稳定 → 重跑并记录
  | 'requirement_gap' // 需求或契约不清、互相矛盾 → 产品 / 人
  | 'unknown' // 判不了 → 人

export type FixScope = 'mechanical' | 'semantic'

export interface JudgeVerdict {
  /** 被判决的对象，通常是用例 ID。 */
  subject: string
  category: VerdictCategory
  confidence: number
  rationale: string
  /** 判决依据：证据路径、日志行、request_id 等。 */
  evidence: string[]
  /** 修复类别：mechanical 可自动合入，semantic（改断言预期、增删验证点）必须人确认。 */
  fixScope?: FixScope
  fixHint?: string
}

/**
 * 判决节点。
 * - target 节点的结构化结果必须形如 `{ failures: Array<{ subject: string; [k: string]: unknown }> }`；没有失败时判决节点直接成功、不调模型。
 * - 路由目标节点必须在 needs 里依赖本判决节点；引擎只运行"分到了失败"的路由目标，其余记为 skipped。
 * - 路由目标通过 `ctx.resultOf(<judgeId>)` 读到 `{ verdicts, routed: Record<NodeId, string[]> }`。
 */
export interface JudgeNodeDef extends BaseNodeDef {
  kind: 'judge'
  role: string
  /** 被判决的执行节点（其结果里带失败列表）。 */
  target: NodeId
  /** 每类判决路由到哪个节点去修；'human' 表示进待办；'ignore' 表示只记录。 */
  routes: Partial<Record<VerdictCategory, NodeId | 'human' | 'ignore'>>
  harness?: HarnessSelector
}

export interface LoopNodeDef extends BaseNodeDef {
  kind: 'loop'
  /** 循环体：一组子节点（子 DAG），每轮整体重跑。 */
  body: NodeDef[]
  /** 收敛条件：返回 true 即退出循环。 */
  until: (ctx: NodeContext) => boolean | Promise<boolean>
  maxIterations: number
  /** 轮次用完仍未收敛：交人 / 失败。 */
  onExhausted?: 'human' | 'fail'
}

/** planner 产出的条目：模型规划出来的子任务。 */
export interface PlannedItem {
  key: string
  title: string
  /** 条目自带的参数，透传给模板生成的子节点。 */
  params?: Record<string, unknown>
  /** 条目之间的依赖（引用其他条目的 key）。 */
  dependsOn?: string[]
  /** 模型建议的角色；必须在 allowedRoles 里。 */
  role?: string
}

/** 有边界的动态规划：模型决定拆成哪些子任务，代码决定每个子任务长什么样、最多拆多少。 */
export interface PlannerNodeDef extends BaseNodeDef {
  kind: 'planner'
  role: string
  prompt: string | ((ctx: NodeContext) => string | Promise<string>)
  /** 每个条目展开成哪些节点（子 DAG）。子节点 id 会被加上前缀。 */
  expand: (item: PlannedItem) => NodeDef[]
  maxItems: number
  allowedRoles?: string[]
  harness?: HarnessSelector
}

// ------------------------------------------------------------ 评审（docs/design/18）

export interface ReviewerSpec {
  role: string
  /** 评审侧重点，拼进评审者的 prompt。 */
  focus?: string
  /** 覆盖角色默认的 harness（推荐与作者不同厂商）。 */
  harness?: HarnessSelector
  checklist?: string[]
}

/** 打回重做：评审轮次用完后回到上游节点重新产出。 */
export interface ReworkPolicy {
  rework: NodeId
  /** 打回次数上限，超过后交人（默认 1）。 */
  maxReworks?: number
}

/**
 * 评审节点：多个评审者各自独立上下文评审产物；不通过时作者按问题清单修改，进入下一轮。
 * 每轮的评审记录与作者回应写入存放区 reviews/<节点>/round-<n>.json。
 */
export interface ReviewNodeDef extends BaseNodeDef {
  kind: 'review'
  /** 被评审的产物路径（存放区，支持 glob）；或代码评审：某个绑定仓库在本运行中的改动。 */
  target: string[] | { code: { repo: string; base?: string } }
  /** 负责按意见修改的作者（新会话）。 */
  author: { role: string; prompt?: string | ((ctx: NodeContext) => string | Promise<string>); harness?: HarnessSelector }
  reviewers: ReviewerSpec[]
  /** 通过规则，默认 'all'。 */
  pass?: 'all' | 'majority' | { minScore: number }
  /** 评审轮次上限（含首轮）。 */
  maxRounds: number
  onExhausted: 'human' | 'fail' | ReworkPolicy
  /** agent 全部通过后再交人确认。 */
  humanSignoff?: boolean
  rubric?: string
}

export type ReviewVerdict = 'approve' | 'request_changes' | 'reject'

export interface ReviewIssue {
  id: string
  severity: 'blocker' | 'major' | 'minor' | 'nit'
  location?: string
  description: string
  suggestion?: string
}

export interface ReviewRecord {
  round: number
  reviewer: string
  verdict: ReviewVerdict
  score?: number
  summary: string
  issues: ReviewIssue[]
  /** 本轮评审看到的产物版本。 */
  artifacts: ArtifactRef[]
  at: Timestamp
}

export interface ReviewResponse {
  round: number
  issueId: string
  reviewer: string
  action: 'fixed' | 'declined' | 'deferred'
  note: string
}

export interface ReviewRound {
  round: number
  passed: boolean
  records: ReviewRecord[]
  /** 作者对本轮问题的回应（未通过时才有）。 */
  responses: ReviewResponse[]
  /** 作者修改后产生的新版本。 */
  revised: ArtifactRef[]
}

export interface SubflowNodeDef extends BaseNodeDef {
  kind: 'subflow'
  workflow: WorkflowDefinition
  args?: Record<string, unknown>
}

export type NodeDef =
  | ScriptNodeDef
  | AgentNodeDef
  | GateNodeDef
  | HumanNodeDef
  | JudgeNodeDef
  | LoopNodeDef
  | PlannerNodeDef
  | ReviewNodeDef
  | SubflowNodeDef

export interface WorkflowDefinition {
  id: string
  title: string
  description?: string
  version: string
  stages: StageDef[]
  nodes: NodeDef[]
}

// ============================================================ Workflow 快照（去掉函数后的纯数据，供 server / web 画图）

export interface SnapshotNode {
  id: NodeId
  kind: NodeKind
  title: string
  stage?: string
  needs: NodeId[]
  role?: string
  harness?: string
  inputs?: InputSpec[]
  outputs?: OutputSpec[]
  /** 静态 prompt 原文；动态 prompt 记为 undefined（实际 prompt 见 NodeDetail.prompt）。 */
  prompt?: string
  /** judge：判决目标与路由。 */
  target?: NodeId
  routes?: JudgeNodeDef['routes']
  /** loop：循环体。 */
  body?: SnapshotNode[]
  maxIterations?: number
  /** planner：上限与可选角色。 */
  maxItems?: number
  allowedRoles?: string[]
  /** gate：检查项标题；rubric 检查带阈值。 */
  checks?: Array<{ id: string; kind: GateCheck['kind']; title?: string; threshold?: number }>
  /** human：问题、表单类型、选项。 */
  ask?: string
  form?: HumanNodeDef['form']
  choices?: string[]
  /** review：评审配置（作者、评审者、规则、轮次与打回策略）。 */
  review?: {
    target: ReviewNodeDef['target']
    author: string
    reviewers: Array<{ role: string; focus?: string; harness?: string }>
    pass: NonNullable<ReviewNodeDef['pass']>
    maxRounds: number
    onExhausted: ReviewNodeDef['onExhausted']
    humanSignoff?: boolean
  }
  /** 写代码的节点绑定的仓库（TaktConfig.repos 的 id）。 */
  repo?: string
}

export interface WorkflowSnapshot {
  id: string
  title: string
  description?: string
  version: string
  stages: StageDef[]
  nodes: SnapshotNode[]
}

// ============================================================ 运行状态

export type RunStatus = 'running' | 'succeeded' | 'failed' | 'waiting_human' | 'cancelled'

export type NodeStatus =
  | 'pending' // 上游未完成
  | 'ready' // 可以跑了，等调度
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'blocked' // 缺输入 / 守卫拦截 / 判决要求人介入
  | 'waiting_human'
  | 'skipped'
  | 'stale' // 上游产物被修改，结果过期，需要重跑
  | 'cancelled'

export interface NodeState {
  id: NodeId
  status: NodeStatus
  attempts: number
  iteration?: number
  startedAt?: Timestamp
  endedAt?: Timestamp
  /** 节点开始时实际解析到的输入版本（用于 stale 传播和溯源）。 */
  inputs?: ArtifactRef[]
  outputs: ArtifactRef[]
  result?: unknown
  error?: string
  /** harness 会话 ID，用于续聊和回看 transcript。 */
  sessionRef?: { harness: string; sessionId: string }
  usage?: Usage
  /** review 节点：当前评审轮次。 */
  round?: number
  /** 被打回重做的次数（rework 目标节点上累计）。 */
  reworks?: number
  /** 写代码节点使用的 worktree。 */
  worktree?: { repo: string; path: string; branch: string; base: string }
}

/** planner 动态展开记录：可视化时把这些节点画到 planner 下面。 */
export interface Expansion {
  plannerId: NodeId
  items: PlannedItem[]
  nodeIds: NodeId[]
  /** 展开出来的节点定义快照（id 已加前缀）：运行图和 stale 传播都以它为准。 */
  nodes?: SnapshotNode[]
  at: Timestamp
}

export interface RunState {
  runId: RunId
  workflowId: string
  workflowVersion: string
  requirementId: RequirementId
  status: RunStatus
  startedAt: Timestamp
  endedAt?: Timestamp
  args: Record<string, unknown>
  nodes: Record<NodeId, NodeState>
  expansions: Expansion[]
}

// ============================================================ 事件（审计日志）

export interface EventPayloads {
  'run.started': { workflowId: string; workflowVersion: string; args: Record<string, unknown> }
  'run.finished': { status: RunStatus }
  'node.ready': Record<string, never>
  'node.started': { attempt: number; iteration?: number }
  'node.finished': { status: NodeStatus; outputs: ArtifactRef[]; result?: unknown; usage?: Usage }
  'node.failed': { error: string; attempt: number }
  'node.stale': { cause: ArtifactRef }
  'artifact.written': { ref: ArtifactRef; kind: ArtifactKind; sha256: string }
  'artifact.edited': { ref: ArtifactRef; reason: string }
  'artifact.untracked': { path: string; sha256: string }
  'gate.result': { pass: boolean; checks: GateCheckResult[] }
  'judge.verdict': { verdicts: JudgeVerdict[]; routed: Array<{ subject: string; to: string }> }
  'human.requested': { requestId: string; ask: string; form: HumanNodeDef['form']; choices?: string[] }
  'human.answered': { requestId: string; decision?: string; answer?: string }
  'harness.started': { harness: string; model?: string; sessionId?: string }
  'harness.message': { role: 'assistant' | 'user' | 'system'; text: string }
  'harness.tool_call': { tool: string; input: string; output?: string; ok?: boolean }
  'harness.usage': Usage
  'context.assembled': ContextSnapshot
  'context.compacted': CompactionRecord
  'knowledge.query': { query: KnowledgeQuery; sources: string[]; hits: number }
  'dag.expanded': Expansion
  'guard.violation': { rule: string; paths: string[]; action: 'reverted' | 'blocked' | 'flagged' }
  'review.round': { round: number; passed: boolean; verdicts: Array<{ reviewer: string; verdict: ReviewVerdict; score?: number; issues: number }> }
  'review.response': { round: number; responses: ReviewResponse[]; revised: ArtifactRef[] }
  'review.exhausted': { rounds: number; action: 'rework' | 'human' | 'fail' }
  'rework.started': { from: NodeId; to: NodeId; count: number; feedback: string; reset: NodeId[] }
  'worktree.created': { repo: string; path: string; branch: string; base: string }
  'task.dispatched': { taskRunId: string; role: string; title: string; by: Actor }
  log: { level: 'info' | 'warn' | 'error'; message: string }
}

export type EventType = keyof EventPayloads

/**
 * 事件信封。events.jsonl 只追加；hash = sha256(prevHash + 规范化后的 {seq,ts,runId,nodeId,type,actor,data})，
 * 形成哈希链，任何事后篡改都能被 `takt audit verify` 发现。
 */
export interface EventEnvelope<T extends EventType = EventType> {
  seq: number
  ts: Timestamp
  runId: RunId
  nodeId?: NodeId
  type: T
  actor: Actor
  data: EventPayloads[T]
  prevHash: string
  hash: string
}

// ============================================================ 上下文账本

export type ContextSource =
  | 'system' // harness 自带的系统提示
  | 'role' // 角色说明（AgentProfile）
  | 'skill'
  | 'artifact' // 公共存放区产物
  | 'knowledge' // 知识检索结果
  | 'prompt' // 节点 prompt
  | 'history' // 续聊带入的历史
  | 'tool_result' // 运行中工具返回

export interface ContextItem {
  id: string
  source: ContextSource
  title: string
  /** 文件路径 / URL / 符号名。 */
  ref?: string
  /** 估算 token 数（字符数 / 4 的近似即可，harness 能报真实值时以真实值为准）。 */
  tokens: number
  /** 声明了但没读 / 被预算裁掉时为 false，并写明 reason。 */
  included: boolean
  reason?: string
}

/** 一个 agent 节点在某一时刻的上下文构成：可视化成堆叠条。 */
export interface ContextSnapshot {
  nodeId: NodeId
  at: Timestamp
  budgetTokens: number
  totalTokens: number
  items: ContextItem[]
}

/** 一次压缩：压缩前后 token、摘要、丢掉了什么。 */
export interface CompactionRecord {
  nodeId: NodeId
  at: Timestamp
  trigger: 'auto' | 'manual' | 'policy'
  beforeTokens: number
  afterTokens: number
  summary: string
  dropped: string[]
}

// ============================================================ Harness（执行内核）适配

export interface HarnessRequest {
  prompt: string
  cwd: string
  model?: string
  effort?: HarnessSelector['effort']
  /** 续聊。 */
  sessionId?: string
  /** 追加到系统提示的角色说明。 */
  systemAppend?: string
  env?: Record<string, string>
  timeoutMs?: number
  /** 要求最终输出满足的 JSON Schema（harness 支持时透传，不支持时由适配器做提取 + 校验）。 */
  resultSchema?: Record<string, unknown>
  /** 把模型指到另一家 LLM API：引擎已把模型别名解析成厂商模型 ID（放在 model），这里给连接信息；适配器负责翻译成该 harness 的配置。 */
  provider?: { id: string } & ProviderConfig
  /** 引擎解析出的模型元数据（成本计算、压缩阈值用）。 */
  modelConfig?: Pick<ModelConfig, 'price' | 'contextWindow'>
  /** 在哪个沙箱里启动 harness 进程；不传则直接在本机启动（local）。 */
  sandbox?: Sandbox
  /** native harness 的工具约束：写权限（glob，相对 cwd）与是否允许 bash。 */
  tools?: { writeScope?: string[]; allowBash?: boolean }
  signal?: AbortSignal
}

export type HarnessEvent =
  | { type: 'started'; sessionId?: string; model?: string }
  | { type: 'message'; role: 'assistant' | 'user' | 'system'; text: string }
  | { type: 'tool_call'; tool: string; input: string; output?: string; ok?: boolean }
  | { type: 'usage'; usage: Usage }
  | { type: 'compacted'; record: Omit<CompactionRecord, 'nodeId'> }

export interface HarnessResult {
  ok: boolean
  finalText: string
  structured?: unknown
  sessionId?: string
  usage?: Usage
  exitCode?: number
  error?: string
  /** 原始 transcript 落盘位置（便于审计回看）。 */
  transcriptPath?: string
}

/** harness 能力声明：引擎据此降级（见 docs/design/13-扩展性与生态.md）。缺省视为全部 false。 */
export interface HarnessCapabilities {
  resume?: boolean
  structuredOutput?: boolean
  toolEvents?: boolean
  usage?: boolean
  cost?: boolean
  compactionEvents?: boolean
  customProvider?: boolean
  /** customProvider 时能接哪些协议（引擎据此校验，不按 harness id 写死）。 */
  providerProtocols?: ProviderProtocol[]
  /** 必须配置 provider 才能运行（如 native）。 */
  requiresProvider?: boolean
  sandbox?: boolean
  mcp?: boolean
}

export interface HarnessAdapter {
  /** claude-code / codex / dsh / mock …… */
  id: string
  displayName: string
  capabilities?: HarnessCapabilities
  available(): Promise<{ ok: boolean; reason?: string }>
  run(req: HarnessRequest, onEvent: (e: HarnessEvent) => void): Promise<HarnessResult>
}

/** 声明式 CLI 适配：任何能非交互执行的 Agent CLI，配置即可接入（kind: 'cli'）。 */
export interface CliHarnessConfig {
  id: string
  kind: 'cli'
  displayName?: string
  /** 命令模板，可用占位符：{{prompt}} {{promptFile}} {{cwd}} {{model}} {{sessionId}}。 */
  command: string[]
  /** prompt 传入方式：stdin / 参数（{{prompt}}）/ 文件（{{promptFile}}）。 */
  promptVia?: 'stdin' | 'arg' | 'file'
  model?: { flag?: string; env?: string }
  resume?: { args: string[] }
  env?: Record<string, string>
  output: {
    format: 'text' | 'jsonl'
    /** jsonl 时的字段映射（点路径），例如 { type: 'type', text: 'message.content', sessionId: 'session_id' }。 */
    events?: { type?: string; text?: string; tool?: string; toolInput?: string; sessionId?: string; inputTokens?: string; outputTokens?: string; final?: { field: string; equals: string } }
  }
  /** 探测可用性的命令，退出码 0 即可用。 */
  available?: string[]
  capabilities?: HarnessCapabilities
}

// ============================================================ LLM API（ModelProvider）

export type ProviderProtocol = 'openai-chat' | 'openai-responses' | 'anthropic-messages' | 'gemini' | (string & {})

export interface ProviderConfig {
  protocol: ProviderProtocol
  baseURL?: string
  /** 只写环境变量名，不写密钥。 */
  apiKeyEnv?: string
  headers?: Record<string, string>
  /** 厂商预设名（deepseek / moonshot / zhipu / dashscope / ark / openrouter / ollama …），提供默认 baseURL。 */
  preset?: string
}

export interface ModelConfig {
  provider: string
  /** 厂商侧的模型 ID。 */
  id: string
  contextWindow?: number
  /** 每百万 token 的价格（美元），用于成本统计。 */
  price?: { input: number; output: number; cachedInput?: number }
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  toolCallId?: string
  toolCalls?: ToolCall[]
}

export interface ToolCall {
  id: string
  name: string
  /** JSON 字符串。 */
  arguments: string
}

export interface ToolSpec {
  name: string
  description: string
  /** JSON Schema。 */
  parameters: Record<string, unknown>
}

export interface ChatRequest {
  model: string
  messages: ChatMessage[]
  tools?: ToolSpec[]
  /** 要求输出满足的 JSON Schema（协议支持时原生透传）。 */
  responseSchema?: Record<string, unknown>
  maxOutputTokens?: number
  temperature?: number
  signal?: AbortSignal
}

export interface ChatResponse {
  message: ChatMessage
  stopReason: 'end' | 'tool_calls' | 'length' | 'error'
  usage?: Usage
}

/** 一种 LLM API 协议的客户端。native harness 用它跑 agent loop。 */
export interface ModelProvider {
  id: string
  protocol: ProviderProtocol
  chat(req: ChatRequest): Promise<ChatResponse>
  /** 探测：密钥是否存在、地址是否可达。 */
  available(): Promise<{ ok: boolean; reason?: string }>
}

// ============================================================ 插件

/** 插件：npm 包或 .takt/plugins/*.ts 的默认导出。apiVersion 主版本不匹配时拒绝加载。 */
export interface TaktPlugin {
  name: string
  apiVersion: 1
  harnesses?: Array<HarnessAdapter | ((ctx: { config: TaktConfig; projectDir: string }) => HarnessAdapter)>
  providers?: Record<string, (config: ProviderConfig) => ModelProvider>
  knowledge?: Array<(ctx: { projectDir: string; options?: Record<string, unknown> }) => KnowledgeSource>
  workflows?: WorkflowDefinition[]
  /** 角色档案：role → markdown 全文（含 frontmatter）。 */
  roles?: Record<string, string>
}

// ============================================================ 角色（子 Agent）

/**
 * 角色档案：`.takt/agents/<role>.md`，frontmatter 写结构化字段，正文写角色说明。
 * 用户可以自定义任意角色；planner 节点只能从 allowedRoles 里选。
 */
export interface AgentProfile {
  role: string
  title: string
  description: string
  harness: HarnessSelector
  skills: string[]
  /** 默认写权限（glob）。节点上的 writeScope 只能收窄，不能放宽。 */
  writeScope: string[]
  readScope?: string[]
  /** native harness 是否允许 bash 工具（默认关闭）。 */
  allowBash?: boolean
  /** 角色说明正文（markdown）。 */
  instructions: string
}

// ============================================================ 知识层（存量项目）

export type KnowledgeIntent =
  | 'fact' // 实时事实：接口注册、配置取值 → 查实时接口
  | 'symbol' // 精确符号 / 有没有这个东西 → rg
  | 'impact' // 调用链 / 影响面 → CodeGraph
  | 'business' // 业务规则、产品知识 → Wiki
  | 'history' // 为什么这么写 → git 历史、过往需求存放区
  | 'schema' // 数据库表结构、字段口径 → 数据库元数据

export interface KnowledgeQuery {
  text: string
  intent?: KnowledgeIntent
  /** 限定范围：模块路径、需求 ID、标签。 */
  scope?: string[]
  limit?: number
}

export interface KnowledgeHit {
  sourceId: string
  title: string
  /** 路径 / URL / 符号 / 表名。 */
  ref: string
  snippet: string
  score?: number
  /** 证据等级与取证时间：过期或冲突的只当参考。 */
  evidenceLevel?: 'verified' | 'derived' | 'stale' | 'conflict'
  fetchedAt?: Timestamp
}

export interface KnowledgeSource {
  id: string
  kind: 'grep' | 'wiki' | 'codegraph' | 'database' | 'api-registry' | 'git-history' | 'workspace' | string
  /** 能回答哪些 intent，路由器据此选源。 */
  intents: KnowledgeIntent[]
  describe(): string
  query(q: KnowledgeQuery): Promise<KnowledgeHit[]>
}

// ============================================================ 追溯图与度量

export type TraceNodeType = 'requirement' | 'ac' | 'artifact' | 'case' | 'task' | 'code' | 'evidence' | 'verdict' | 'run-node'

export interface TraceGraph {
  nodes: Array<{ id: string; type: TraceNodeType; label: string; ref?: ArtifactRef; status?: string }>
  edges: Array<{ from: string; to: string; rel: 'derives' | 'covers' | 'implements' | 'verifies' | 'produced' | 'judged' }>
}

export interface RequirementMetrics {
  requirementId: RequirementId
  runs: number
  /** 首跑可用率：首轮执行就通过的用例占比。 */
  firstPassRate?: number
  loopIterations: number
  humanInterventions: number
  verdicts: Partial<Record<VerdictCategory, number>>
  usage: Usage
  leadTimeHours?: number
  /** 验收标准覆盖：每条 AC 有没有用例、用例过没过。 */
  acCoverage?: Array<{ ac: string; title: string; cases: number; passed: number; failed: number; status: 'covered' | 'partial' | 'uncovered' }>
}

// ============================================================ 沙箱（docs/design/17）

export interface SandboxMount {
  /** 宿主机路径。 */
  source: string
  /** 沙箱内路径（local 提供方下与 source 相同）。 */
  target: string
  mode: 'ro' | 'rw'
}

export interface SandboxSpec {
  /** 沙箱内工作目录。 */
  workdir: string
  mounts: SandboxMount[]
  /** 只注入该任务需要的环境变量（密钥按 apiKeyEnv 精确注入）。 */
  env?: Record<string, string>
  network?: 'none' | 'egress' | 'full'
  /** docker 镜像。 */
  image?: string
  limits?: { cpus?: number; memoryMb?: number; timeoutMs?: number }
}

export interface SandboxSpawnOptions {
  cwd?: string
  env?: Record<string, string>
  stdin?: 'pipe' | 'ignore'
}

export interface Sandbox {
  id: string
  provider: string
  spec: SandboxSpec
  /** 在沙箱内启动进程；返回值与 child_process.spawn 一致，适配器无需区分。 */
  spawn(command: string, args: string[], opts?: SandboxSpawnOptions): import('node:child_process').ChildProcess
  exec(command: string, args: string[], opts?: SandboxSpawnOptions & { input?: string; timeoutMs?: number }): Promise<{ code: number; stdout: string; stderr: string }>
  /** 沙箱内路径 → 宿主机路径（用于收集产物、算 diff）。 */
  hostPath(path: string): string
  dispose(): Promise<void>
}

export interface SandboxProvider {
  /** local / bwrap / docker …… */
  id: string
  available(): Promise<{ ok: boolean; reason?: string }>
  create(spec: SandboxSpec): Promise<Sandbox>
}

// ============================================================ 项目空间（docs/design/14）

export interface SpaceMember {
  id: string
  name: string
  role: 'owner' | 'maintainer' | 'member' | 'viewer'
  email?: string
}

export interface RepoBinding {
  id: string
  /** 远程地址；没有时 path 必须是本地已有的 git 仓库。 */
  url?: string
  /** 本地路径（相对空间根目录或绝对路径）。 */
  path: string
  defaultBranch: string
  purpose?: 'app' | 'library' | 'test' | 'docs' | (string & {})
  description?: string
}

export interface SkillRecord {
  name: string
  /** 相对空间根目录的 SKILL.md 路径。 */
  path: string
  description: string
}

// ============================================================ 需求群聊与 Lead Agent（docs/design/15）

export interface RoomMember {
  id: string
  kind: 'human' | 'lead' | 'agent'
  name: string
  role?: string
}

export type RoomMessageKind = 'text' | 'system' | 'attention' | 'task' | 'artifact' | 'progress'

export interface RoomMessage {
  id: string
  roomId: string
  seq: number
  author: Actor
  at: Timestamp
  kind: RoomMessageKind
  text: string
  /** 被 @ 的成员 id（含 'lead'）。 */
  mentions?: string[]
  replyTo?: string
  refs?: { artifacts?: ArtifactRef[]; runId?: RunId; nodeId?: NodeId; taskRunId?: RunId; requestId?: string }
}

export interface Room {
  id: string
  requirementId: RequirementId
  title: string
  members: RoomMember[]
  createdAt: Timestamp
  /** 绑定的外部 IM 群（飞书 / Slack …）。 */
  external?: { kind: string; chatId: string }
}

/** 临时任务：Lead 派发给某个角色的一次性工作，执行时是一次普通运行（可审计）。 */
export interface TaskSpec {
  role: string
  title: string
  instructions: string
  inputs?: string[]
  outputs?: Array<{ path: string; kind: ArtifactKind }>
  writeScope?: string[]
  /** 在哪个绑定代码仓库里改代码。 */
  repo?: string
  /** 完成后是否走一轮评审（默认按角色：改代码的任务默认评审）。 */
  review?: { reviewers: string[]; maxRounds: number } | false
}

export type LeadAction =
  | { type: 'reply'; text: string; mentions?: string[] }
  | { type: 'dispatch_task'; task: TaskSpec }
  | { type: 'start_run'; workflowId: string; args?: Record<string, unknown> }
  | { type: 'resume_run'; runId: RunId }
  | { type: 'cancel_run'; runId: RunId; reason: string }
  | { type: 'request_human'; to: string; ask: string; form: HumanNodeDef['form']; choices?: string[] }
  | { type: 'propose_workflow_change'; workflowId: string; description: string; source?: string }
  | { type: 'update_notes'; content: string }

/** Lead 每次被触发的输出：一条回复 + 一组动作（由服务端校验后执行）。 */
export interface LeadTurn {
  reply: string
  actions: LeadAction[]
}

export interface LeadActionResult {
  action: LeadAction['type']
  ok: boolean
  message: string
  refs?: RoomMessage['refs']
}

// ============================================================ 项目配置

export interface TaktConfig {
  project: { name: string; description?: string }
  /** 项目空间：id 用于多空间 serve 的路由。 */
  space?: { id: string }
  members?: SpaceMember[]
  /** 绑定的代码仓库。 */
  repos?: RepoBinding[]
  /** 目录约定；不写时新空间用顶层 agents/ workflows/ skills/ knowledge/ requirements/，旧项目沿用 .takt/ 下的目录。 */
  paths?: { agents?: string; workflows?: string; skills?: string; knowledge?: string; requirements?: string }
  sandbox?: { provider: 'local' | 'bwrap' | 'docker' | (string & {}); image?: string; network?: SandboxSpec['network'] }
  /** 需求群的 Lead Agent。 */
  lead?: { harness?: HarnessSelector; progressUpdates?: boolean }
  /** 角色 → 默认 harness（AgentProfile 可覆盖）。 */
  roles?: Record<string, HarnessSelector>
  /** 已注册的 workflow 文件（相对项目根目录）。 */
  workflows: string[]
  knowledge?: Array<{ id: string; kind: string; options?: Record<string, unknown> }>
  /** 上下文预算（token），超过即在账本里标红并触发策略。 */
  contextBudgetTokens?: number
  /** 插件：npm 包名或相对路径。 */
  plugins?: string[]
  /** 额外注册的 harness（声明式 CLI 适配等）。 */
  harnesses?: CliHarnessConfig[]
  /** LLM API 提供方：id → 配置。 */
  providers?: Record<string, ProviderConfig>
  /** 模型别名：别名 → 配置。 */
  models?: Record<string, ModelConfig>
}
