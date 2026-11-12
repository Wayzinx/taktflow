/**
 * taktflow 核心契约。
 *
 * 所有包（engine / harness / knowledge / server / cli / web）都只依赖这里的类型互相协作。
 * 改这里等于改协议：先改 docs/design 里对应的设计文档，再改类型。
 */

import type { CatalogModel } from './api.js'

// ============================================================ 通用

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

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
  | { type: 'human'; id: string }
  /** invocationId：产出这条记录的那次调用（docs/design/21 §2）；同一节点 fallback 的每个候选各是一次调用。 */
  | { type: 'agent'; role: string; harness: string; model?: string; invocationId?: string }
  | { type: 'system'; id: string }

export interface Usage {
  inputTokens: number
  outputTokens: number
  cachedTokens?: number
  /** 报了成本的那部分调用的合计；没有这个字段表示成本未上报（不是 $0）。 */
  costUsd?: number
  /** 有 costUsd 时，其中没报成本的调用的 token（输入 + 输出）；全部报了时省略。 */
  unpricedTokens?: number
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
  /** 新建时写的背景、目标与验收标准（同时落盘为 inputs/prd.md）。 */
  description?: string
  /** 截止时间：管家据此判断 deadline 风险。 */
  dueAt?: Timestamp
  /** 归档时间：status 为 archived 时有值；恢复时清空并按运行记录重新推导状态。 */
  archivedAt?: Timestamp
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
  | 'defect' // 交付后发现的缺陷与归因（docs/design/20）
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
  producedBy?: { runId: RunId; nodeId: NodeId; invocationId?: string }
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
  effort?: Effort
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
  /** 一句话目标：节点卡片只显示目标与小结（docs/design/19）。 */
  goal?: string
  /** 负责人职责标签（如 pm / rd / qa）：本节点产生的待办派给 duties 含此标签的空间成员。 */
  owner?: string
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
  /** 知识：旧写法为预取查询数组（等价于 { prefetch, mode: 'prefetch' }）；新写法见 KnowledgeNodeSpec（docs/design/23）。 */
  knowledge?: KnowledgeQuery[] | KnowledgeNodeSpec
  /** fresh：每次新会话（默认）；resume：续上一次同节点会话。 */
  session?: 'fresh' | 'resume'
  /** 让 agent 以 JSON 输出结构化结果。 */
  resultSchema?: Record<string, unknown>
  /** 在哪个绑定代码仓库里工作：引擎为节点创建独立 worktree 并作为 cwd。 */
  repo?: string
  /**
   * worktree 从哪个提交开（分支名或提交）；可按上游结果算，返回 undefined 时用默认分支。
   * 不设时：依赖同仓库的上游任务就叠在它们的改动上，否则从默认分支开。
   */
  base?: string | ((ctx: NodeContext) => string | undefined)
  /**
   * 完成标准：逐条可验证。引擎要求结果带 checks（每条一项、pass 为 true 时必须有证据），
   * 任何一条缺失 / 未通过 / 无证据即节点失败，不以进程退出码为准。
   */
  completion?: string[]
  /** 往存放区写了未声明的文件时移入隔离区并记 guard.violation（rule: output-contract）。 */
  strictOutputs?: boolean
}

/** 完成标准的逐条自检结果（agent 输出，引擎校验）。 */
export interface CompletionCheck {
  /** 'c1'、'c2' …，与 completion 的下标对应。 */
  id: string
  criterion: string
  pass: boolean
  /** 证据：产物路径、命令与输出摘要、用例 ID 等；pass 为 true 时必填。 */
  evidence?: string
}

/** 门禁里的单项检查。fail-closed：检查本身出错按不通过处理。 */
export type GateCheck =
  | { id: string; kind: 'command'; run: string; title?: string }
  | { id: string; kind: 'function'; title?: string; fn: (ctx: NodeContext) => Promise<GateCheckResult> }
  | { id: string; kind: 'rubric'; title?: string; role: string; rubric: string; threshold: number }
  /**
   * 交付校验：每条 AC 有用例、用例最近一次执行通过、有证据（读追溯图）。
   * 给了 role 时再请该角色独立复核（不得与产出角色相同）。
   */
  | { id: string; kind: 'acceptance'; title?: string; role?: string }

export interface GateCheckResult {
  id: string
  pass: boolean
  /** 三态（docs/design/21 §4）：error 是检查本身出错（流程问题），不算产物缺陷；pass 仍按 fail-closed（error 时为 false）。 */
  status?: 'pass' | 'fail' | 'error'
  checkpointId?: string
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
  /** 等人限时（docs/design/26 §3）；缺省用 TaktConfig.human。 */
  timebox?: HumanTimebox
  /** form 为 answer 时的默认假设：到交还时限无人回答就按它继续（审批与选择永不自动作答）。 */
  assumption?: string
}

/** 时长写法：'30m' / '2h' / '1d'。 */
export interface HumanTimebox {
  remindAfter?: string
  handbackAfter?: string
}

/** 判决类别：执行失败的根因归属。 */
export type VerdictCategory =
  | 'product_bug' // 产品代码缺陷 → 开发
  | 'case_defect' // 用例本身错（预期写错、与需求矛盾）→ 测试设计
  | 'script_defect' // 脚本实现错（定位、等待、取值）→ 自动化
  | 'env_issue' // 环境 / 数据 / 依赖问题 → 执行底座
  | 'flaky' // 不稳定 → 重跑并记录
  | 'requirement_gap' // 需求或契约不清、互相矛盾 → 产品 / 人
  | 'test_data' // 测试数据缺失或脏 → 数据准备
  | 'deployment' // 部署未完成 / 部署版本不对 → 发布
  | 'permission' // 账号、权限、鉴权 → 人
  | 'external_dependency' // 外部服务不可用 → 记录并等待
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
  /** 连续这么多轮没有新增 / 变化的 blocker、major 问题仍不通过，就提前按 onExhausted 处理（默认 2，0 关闭）。 */
  stopAfterNoProgress?: number
  /** 裁决者：只在评审者结论冲突时调用（有人通过、有人要求修改且含 blocker）。 */
  arbiter?: ReviewerSpec
  /** 比较依据（存放区 glob，docs/design/21 §1）：与被评审对象一起物化进只读快照，例如系分评审带 PRD。 */
  references?: string[]
}

export type ReviewVerdict = 'approve' | 'request_changes' | 'reject'

export interface ReviewIssue {
  id: string
  severity: 'blocker' | 'major' | 'minor' | 'nit'
  location?: string
  /** 短标题；问题延续用它和 location、category 算 groupKey。 */
  title?: string
  /** correctness / testability / security / performance / readability …… */
  category?: string
  description: string
  suggestion?: string
  /** 引擎计算：同一类问题跨轮次的稳定键（位置 + 类别 + 标题归一化）。 */
  groupKey?: string
  /** 引擎计算：位置、严重度、描述的指纹；groupKey 相同但指纹变了 = 问题有变化。 */
  fingerprint?: string
  /**
   * 系统问题键 ISS-<n>（docs/design/21 §3）：同一运行同一 review 节点内跨修订有效。
   * 评审者在输出里引用已有键表示同一问题；不引用即新问题，由引擎分配，模型不能自造。
   */
  key?: string
  /** 对应的职责条目（checklist 原文）。 */
  duty?: string
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
  /** 裁决者的记录（只在冲突时出现，决定本轮是否通过）。 */
  arbiter?: boolean
  checkpointId?: string
  invocationId?: string
  /** 职责条目逐条结论；issue 时列出对应问题的 id。 */
  checklist?: Array<{ item: string; status: 'ok' | 'issue' | 'na'; issues?: string[]; note?: string }>
  /** 对上一轮仍未关闭的问题逐键复查：只有 resolved 才算"已验证修复"。 */
  previous?: Array<{ key: string; status: 'resolved' | 'still_open' | 'not_checked'; note?: string }>
}

/** 问题台账：一个 review 节点里每个系统问题键的当前状态与经过（引擎维护，读模型展示）。 */
export interface ReviewIssueEntry {
  key: string
  title: string
  severity: ReviewIssue['severity']
  location?: string
  /** claimed_fixed：作者声称已修；verified_fixed：评审者复查给出 resolved；dismissed / waived：人工不采纳 / 放行。 */
  status: 'open' | 'claimed_fixed' | 'verified_fixed' | 'dismissed' | 'waived'
  raisedBy: string
  groupKey?: string
  duty?: string
  first: { revision: number; round: number; checkpointId?: string }
  last: { revision: number; round: number; checkpointId?: string }
  history: Array<{
    revision: number
    round: number
    action: 'raised' | 'reobserved' | 'claimed_fixed' | 'verified_fixed' | 'still_open' | 'not_checked' | 'dismissed' | 'waived' | 'reopened'
    by: string
    note?: string
    at: Timestamp
  }>
}

/** 系统对问题的观察：与上一轮相比。只由引擎计算，不代表问题已解决。 */
export type IssueObservation = 'new' | 'repeated' | 'changed' | 'not_observed'

export interface ReviewContinuity {
  groupKey: string
  /** 本轮的问题（not_observed 时没有）。 */
  issueId?: string
  reviewer?: string
  /** 上一轮对应的问题。 */
  prevIssueId?: string
  observation: IssueObservation
  /** 作者上轮回应"已修"但本轮重复出现。 */
  regressed?: boolean
}

/** 人对问题的显式处置（留痕）；模型没再提到不会自动改变处置。 */
export interface ReviewDisposition {
  groupKey: string
  state: 'open' | 'resolved' | 'dismissed'
  reason: string
  by: Actor
  at: Timestamp
  /** 处置时问题的指纹：指纹变了处置自动失效、重新打开。 */
  fingerprint?: string
}

export interface ReviewResponse {
  round: number
  issueId: string
  /** 系统问题键（引擎按 issueId 回填）。 */
  key?: string
  reviewer: string
  action: 'fixed' | 'declined' | 'deferred'
  note: string
}

export interface ReviewRound {
  /** 修订内的轮次（从 1 开始）。 */
  round: number
  /** 第几个修订：首次评审为 1，每次打回重做 +1。 */
  revision?: number
  /** 全局递增序号（跨修订不重置）。 */
  seq?: number
  passed: boolean
  records: ReviewRecord[]
  /** 作者对本轮问题的回应（未通过时才有）。 */
  responses: ReviewResponse[]
  /** 作者修改后产生的新版本。 */
  revised: ArtifactRef[]
  /** 本轮评审目标的指纹（产物版本或代码 HEAD）；目标之后变了，这轮结论就过期。 */
  targetFingerprint?: string
  /** 与上一轮相比的问题观察。 */
  continuity?: ReviewContinuity[]
  /** 提前结束的原因：no_progress（连续无新增问题）。 */
  stopReason?: 'no_progress'
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

/** 档位只看改动形状（docs/design/19）：T0 已写死 / T1 单一改动面 / T2 多面串行 / T3 多面不相交并行。 */
export type Tier = 'T0' | 'T1' | 'T2' | 'T3'

export interface RunBudget {
  tokens?: number
  costUsd?: number
  minutes?: number
  /** 同时运行的节点数上限。 */
  concurrency?: number
}

/** workflow 的路由与总负责元数据（都是自然语言或字面量，可在画布上编辑）。 */
export interface WorkflowMeta {
  /** 适用场景：路由器据此选择流程。 */
  useWhen?: string
  /** 适用档位；不写表示不限。 */
  tiers?: Tier[]
  /** 给 Lead 的总负责准则。 */
  leadInstructions?: string
  /** 运行中允许 Lead 提议的调整规则（提议仍需人批准）。 */
  dynamicRules?: string
  budget?: RunBudget
}

export interface WorkflowDefinition extends WorkflowMeta {
  id: string
  title: string
  description?: string
  version: string
  stages: StageDef[]
  nodes: NodeDef[]
}

/** 路由卡：选哪个档位、哪个流程、为什么。 */
export interface RouteDecision {
  tier: Tier
  workflowId: string
  reason: string
  /** 改动面；T3 要求 paths 两两不相交。 */
  surfaces: Array<{ id: string; paths: string[]; repo?: string }>
  /** 本流程要过的门禁 / 评审（节点标题）。 */
  gates: string[]
  roles: string[]
  /** 确定性校验做过的调整，例如"改动面路径相交，T3 降为 T2"。 */
  adjustments?: string[]
  decidedBy: Actor
  at: Timestamp
  /** 人改过档位。 */
  overridden?: { by: Actor; reason: string; from: Tier }
}

// ============================================================ Workflow 快照（去掉函数后的纯数据，供 server / web 画图）

export interface SnapshotNode {
  id: NodeId
  kind: NodeKind
  title: string
  goal?: string
  owner?: string
  stage?: string
  needs: NodeId[]
  role?: string
  harness?: string
  /** agent：完成标准。 */
  completion?: string[]
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
  checks?: Array<{ id: string; kind: GateCheck['kind']; title?: string; threshold?: number; role?: string }>
  /** agent：写权限（学习经验、评测回放时还原节点收窄后的权限）。 */
  writeScope?: string[]
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
    stopAfterNoProgress?: number
    arbiter?: { role: string; focus?: string; harness?: string }
  }
  /** 写代码的节点绑定的仓库（TaktConfig.repos 的 id）。 */
  repo?: string
}

export interface WorkflowSnapshot extends WorkflowMeta {
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
  /** review 节点：当前修订（首次为 1，每次打回 +1）。 */
  revision?: number
  /** 一句话小结（agent 结果的 summary 字段）。 */
  summary?: string
  /** 完成标准自检结果（最近一次）。 */
  checks?: CompletionCheck[]
  /** 失败指纹计数；同一指纹在输入不变时第 2 次出现即停止重试。 */
  failures?: FailureRecord[]
}

export interface FailureRecord {
  /** sha256(节点 : 失败码 : 目标 : 输入身份) 的前 16 位。 */
  fingerprint: string
  /** 失败码：completion.unmet / gate:<检查 id> / judge:<类别> / exit:<码> / subdag（容器的子节点没完成，target 是失败的子节点及其指纹）/ error …… */
  code: string
  target?: string
  /** 输入身份：输入产物版本 + worktree HEAD 的摘要。 */
  inputs: string
  count: number
  firstAt: Timestamp
  lastAt: Timestamp
  message?: string
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
  /** workflow：流水线运行；task：Lead 派发的临时任务。 */
  kind?: 'workflow' | 'task'
  /**
   * 临时任务的来源。hops：派发链的跳数（人发起为 0，任务的产出再派任务 +1，docs/design/26 §4）；
   * chain：上游任务运行 id，从最早到最近。
   */
  origin?: { kind: 'chat'; messageId: string; by: Actor; title: string; hops?: number; chain?: RunId[] }
  route?: RouteDecision
  /** 生效的预算（配置 < workflow 默认 < 启动参数）。 */
  budget?: RunBudget
}

// ============================================================ 事件（审计日志）

export interface EventPayloads {
  'run.started': { workflowId: string; workflowVersion: string; args: Record<string, unknown> }
  'run.finished': { status: RunStatus }
  /** 人工重试失败 / 阻塞的节点：这些节点重置为待跑，运行回到 running（docs/dev/m8-backend-c6.md）。 */
  'run.retried': { nodeIds: NodeId[]; reason?: string }
  'node.ready': Record<string, never>
  /** rewindPoint：节点开始前的文件状态（docs/design/26 §5），回退用。 */
  'node.started': { attempt: number; iteration?: number; rewindPoint?: RewindPoint }
  'node.finished': { status: NodeStatus; outputs: ArtifactRef[]; result?: unknown; usage?: Usage }
  'node.failed': { error: string; attempt: number }
  'node.stale': { cause: ArtifactRef }
  'artifact.written': { ref: ArtifactRef; kind: ArtifactKind; sha256: string }
  /** impact 为 cosmetic（措辞调整）时只记录，不传播 stale；缺省按 semantic。 */
  'artifact.edited': { ref: ArtifactRef; reason: string; impact?: 'cosmetic' | 'semantic' }
  'artifact.untracked': { path: string; sha256: string }
  'gate.result': { pass: boolean; checks: GateCheckResult[] }
  'judge.verdict': { verdicts: JudgeVerdict[]; routed: Array<{ subject: string; to: string }> }
  'human.requested': { requestId: string; ask: string; form: HumanNodeDef['form']; choices?: string[]; assumption?: string; timebox?: HumanTimebox }
  /** 到提醒时限（docs/design/26 §3）：round 从 1 开始，第 2 次起加上 owner。 */
  'human.reminded': { requestId: string; to: string[]; round: number }
  /** 到交还时限、按假设作答（只限 form answer 且有 assumption）。 */
  'human.handed_back': { requestId: string; assumption: string }
  /** boundTo：回答 / 审批时看到的产物版本；之后产物有新版本，这次确认即过期。 */
  'human.answered': { requestId: string; decision?: string; answer?: string; boundTo?: ArtifactRef[] }
  /** model 为 harness 回报的实际模型；contextWindow 来自模型配置（上下文曲线的上限）；skills 为 harness 能证明已加载的技能。 */
  'harness.started': { harness: string; model?: string; sessionId?: string; contextWindow?: number; skills?: string[] }
  'harness.message': { role: 'assistant' | 'user' | 'system'; text: string }
  /**
   * phase：能报开始的 harness 先发 start（无 output）再发 end，用 callId 配对；只报一拍的 harness 不带 phase（视为 end）。
   * durationMs：end 时的耗时（docs/design/26 §1）。
   */
  'harness.tool_call': { tool: string; input: string; output?: string; ok?: boolean; phase?: 'start' | 'end'; callId?: string; durationMs?: number }
  'harness.usage': Usage
  'context.assembled': ContextSnapshot
  'context.compacted': CompactionRecord
  /** queryId 之后的字段为 docs/design/23 新增：召回评测与线上监控用。 */
  'knowledge.query': {
    query: KnowledgeQuery
    sources: string[]
    hits: number
    queryId?: string
    bases?: Array<{ id: string; version: number }>
    top?: Array<{ baseId?: string; ref: string; score: number; rank: number }>
    latencyMs?: number
    tokens?: number
    /** prefetch：节点预取；tool：运行中 kb_query / takt kb query。 */
    via?: 'prefetch' | 'tool'
  }
  /** 节点产物引用了某次查询命中的 ref（隐式相关性信号）。 */
  'knowledge.used': { queryId: string; refs: string[]; artifact: ArtifactRef }
  'dag.expanded': Expansion
  'guard.violation': { rule: string; paths: string[]; action: 'reverted' | 'blocked' | 'flagged' }
  'review.round': { round: number; passed: boolean; verdicts: Array<{ reviewer: string; verdict: ReviewVerdict; score?: number; issues: number }> }
  'review.response': { round: number; responses: ReviewResponse[]; revised: ArtifactRef[] }
  'review.exhausted': { rounds: number; action: 'rework' | 'human' | 'fail'; reason?: 'max_rounds' | 'no_progress' }
  'review.arbitrated': { round: number; arbiter: string; verdict: ReviewVerdict; conflict: string }
  'review.disposition': ReviewDisposition
  'rework.started': { from: NodeId; to: NodeId; count: number; feedback: string; reset: NodeId[] }
  'worktree.created': { repo: string; path: string; branch: string; base: string }
  'worktree.bootstrapped': { repo: string; path: string; command?: string; shared?: string[]; ok: boolean; ms: number; output?: string }
  /** resendOf：重发时为原任务运行 id，reason 为重发原因（docs/design/27 §5）。 */
  'task.dispatched': { taskRunId: string; role: string; title: string; by: Actor; resendOf?: string; reason?: string }
  'node.checks': { checks: CompletionCheck[]; unmet: string[] }
  'retry.suppressed': { fingerprint: string; code: string; count: number; reason: string }
  'budget.warning': { budget: RunBudget; used: { tokens: number; costUsd?: number; minutes: number }; ratio: number }
  'budget.exhausted': { budget: RunBudget; used: { tokens: number; costUsd?: number; minutes: number }; ratio: number }
  'route.decided': RouteDecision
  /** 节点本次执行的配方（docs/design/20）：成绩单按 recipeKey 分组。 */
  'node.recipe': NodeRecipe
  // —— 归因可信度（docs/design/21）——
  /** 调度时分配检查点身份；没执行的检查点也有这一条。 */
  'checkpoint.scheduled': Checkpoint
  'checkpoint.finished': { id: string; status: 'done' | 'error' | 'skipped'; error?: string }
  /** 只读快照已物化（评审者只读这里）。 */
  'snapshot.created': SnapshotManifest
  'invocation.started': InvocationStart
  'invocation.finished': InvocationEnd
  /** 单个评审者（或裁决者）完成即写，不等本轮其他人。 */
  'review.result': { checkpointId: string; revision: number; round: number; record: ReviewRecord }
  /** 问题台账变化：一次一个键。 */
  'review.issue': { key: string; action: ReviewIssueEntry['history'][number]['action']; revision: number; round: number; by: string; checkpointId?: string; note?: string; entry: Omit<ReviewIssueEntry, 'history'> }
  // —— 运行透明与回退（docs/design/26）——
  /** 节点回退到开始前：恢复的文件、因此过期的下游。 */
  /** kept：本节点新建、回退点里没有前一版本的存放区产物，原样保留并随生产节点过期（docs/design/26 §5）。 */
  'node.rewound': { files: Array<{ path: string; scope: 'repo' | 'workspace'; repo?: string; version?: number }>; stale: Array<{ runId: RunId; nodeId: NodeId }>; reason: string; kept?: string[] }
  'lesson.recalled': { ids: string[]; holdout: boolean; tokens: number }
  'lesson.learned': { id: string; title: string; source: Lesson['source'] }
  'lesson.updated': { id: string; status: Lesson['status']; reason: string; stats: Lesson['stats'] }
  /** 结构化输出没通过校验（docs/design/31 §5）：attempt 从 1 起；errors 为「路径：原因」；excerpt 为输出摘录。 */
  'output.invalid': { attempt: number; errors: string[]; excerpt?: string }
  /** 追问修正后通过校验：attempts 为追问次数。 */
  'output.repaired': { attempts: number }
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
  | 'lesson' // 经验库召回（docs/design/19）
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
  /** 只读调用（回放评测、评审者）：声明了 capabilities.readOnly 的 harness 不加载写工具和 shell。 */
  readOnly?: boolean
  /** 本轮可用的 MCP 服务（streamable HTTP）。harness 声明 capabilities.mcp 时才会收到（docs/design/30 §2，管家走外部 harness）。 */
  mcpServers?: Array<{ name: string; url: string; headers?: Record<string, string> }>
  signal?: AbortSignal
}

export type HarnessEvent =
  /** model：实际使用的模型（能拿到时）；effort / skills：harness 能证明的实际值（docs/design/21 §2 的 reported）。 */
  | { type: 'started'; sessionId?: string; model?: string; effort?: string; skills?: string[] }
  | { type: 'message'; role: 'assistant' | 'user' | 'system'; text: string }
  | { type: 'tool_call'; tool: string; input: string; output?: string; ok?: boolean; phase?: 'start' | 'end'; callId?: string; durationMs?: number }
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
  /** 能按请求只读运行（不加载写工具与 shell）。 */
  readOnly?: boolean
  /** 工具调用分开始 / 结束两拍上报。 */
  toolPhases?: boolean
  /** 能按请求覆盖模型 / effort；为 false 时引擎在 invocation 里记 applied: false，不把请求值当实际值。 */
  modelOverride?: boolean
  effortOverride?: boolean
}

export interface HarnessAdapter {
  /** claude-code / codex / dsh / mock …… */
  id: string
  displayName: string
  capabilities?: HarnessCapabilities
  /** detail：版本、ACP 协议版本与 agent 能力等，给设置页的"测试"显示。 */
  available(): Promise<{ ok: boolean; reason?: string; detail?: string; ownReady?: boolean; ownReason?: string }>
  listModels?(): Promise<CatalogModel[]>
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

/**
 * ACP（Agent Client Protocol）agent（docs/design/27 §3）：stdio 上的 JSON-RPC，
 * 一个适配器接所有支持 ACP 的 agent（Gemini CLI、Claude Agent / Codex 的 ACP 适配、OpenCode、Qwen Code、Kimi CLI、Goose、Copilot …）。
 */
export interface AcpHarnessConfig {
  id: string
  kind: 'acp'
  displayName?: string
  /** 内置预设名（见 GET /api/space/runtime 的 presets.acp），提供默认命令与说明；command 给了以 command 为准。 */
  preset?: string
  /** 启动命令，例如 ['gemini', '--experimental-acp']。 */
  command?: string[]
  env?: Record<string, string>
  /**
   * agent 发来 session/request_permission 时的默认处理：allow = 目标在工作目录内时放行一次，否则拒绝；reject = 一律拒绝。
   * 只读运行（HarnessRequest.readOnly）时写类请求一律拒绝，不看这里。缺省 allow。
   */
  permissions?: 'allow' | 'reject'
}

/** 内置 harness 的本机覆盖：可执行文件不在 PATH 里、要加环境变量、或在本空间停用。 */
export interface HarnessOverride {
  /** Claude Code 默认 cli；acp 使用同一 ID 的 ACP 预设。 */
  transport?: 'cli' | 'acp'
  /** 可执行文件路径（替换内置命令的第一个参数）。 */
  command?: string
  env?: Record<string, string>
  disabled?: boolean
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
  /** 同一家 API 的其他协议入口（如 DeepSeek 另有 anthropic-messages 入口）；harness 按自己能接的协议挑，同一把密钥。 */
  endpoints?: Partial<Record<ProviderProtocol, string>>
}

export interface ModelConfig {
  provider: string
  /** 厂商侧的模型 ID。 */
  id: string
  /** chat（默认）或 embedding（知识库向量化用，走 openai 兼容 /embeddings）。 */
  kind?: 'chat' | 'embedding'
  /** embedding 模型的向量维度。 */
  dimensions?: number
  contextWindow?: number
  label?: string
  maxOutput?: number
  reasoning?: boolean
  efforts?: Effort[]
  defaultEffort?: Effort
  input?: string[]
  toolCall?: boolean
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

/** harness 与 LLM API 怎么接上（docs/design/31 §2）：builtin 用 harness 自带的登录与模型；direct 协议对上直连；bridge 经进程内协议桥转换。 */
export type PairingMode = 'builtin' | 'direct' | 'bridge'

export interface Pairing {
  mode: PairingMode
  /** harness 那一侧说的协议（direct / bridge）。 */
  protocol?: ProviderProtocol
  /** bridge 时 provider 那一侧的协议。 */
  upstream?: ProviderProtocol
}

/**
 * 进程内协议桥（docs/design/31 §3）：harness 说的协议与 provider 提供的对不上时，在 127.0.0.1 上开一条只认一次性令牌的路由，
 * 上下行流式双向转换。上游密钥由桥按 provider 的 apiKeyEnv 自己读，不进 harness 进程。
 */
export interface ProviderBridge {
  /** 能否把 harness 说的 accept 协议转成 provider 提供的 upstream 协议。 */
  supports(accept: ProviderProtocol, upstream: ProviderProtocol): boolean
  /**
   * 为一次调用开路由。target 是 provider 提供 upstream 协议的那个入口（protocol / baseURL 已按入口选好）。
   * effort 是这次调用明确选的推理强度：桥按上游协议写进请求（harness 自己发的强度在转换时丢掉，不确定上游认不认）。
   */
  open(target: { id: string } & ProviderConfig, accept: ProviderProtocol, opts?: { model?: string; effort?: Effort; signal?: AbortSignal }): Promise<BridgeRoute>
  /** 关掉所有路由与监听（进程退出、测试收尾）。 */
  close(): Promise<void>
}

export interface BridgeRoute {
  /** 交给 harness 的连接：protocol = accept，baseURL 指向本机桥，apiKeyEnv 指向 env 里的一次性令牌。 */
  provider: { id: string } & ProviderConfig
  /** 合并进 HarnessRequest.env。 */
  env: Record<string, string>
  close(): Promise<void>
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
  /** 能读的知识库（KnowledgeBase.id）；不写即空间绑定的全部。节点上的 knowledge.bases 优先。 */
  knowledge?: string[]
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
  /** 限定知识库（KnowledgeBase.id）；不写时按空间绑定与 intent 路由。 */
  bases?: string[]
}

/** 节点的知识声明（docs/design/23）。 */
export interface KnowledgeNodeSpec {
  /** 可用的知识库；不写即空间绑定的全部（再按 intent 过滤）。 */
  bases?: string[]
  /** 节点开始前检索并写进上下文账本。 */
  prefetch?: KnowledgeQuery[]
  /** prefetch：只预取；tool：只给 kb_query 工具；both：两者都有（默认 both）。 */
  mode?: 'prefetch' | 'tool' | 'both'
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
  /** 来自哪个知识库的哪个版本（新模型的知识库才有）。 */
  baseId?: string
  version?: number
  /** 合并后的名次（1 起）。 */
  rank?: number
  /** 分项得分：检索测试页展示，便于调参。 */
  scores?: { bm25?: number; vector?: number; rerank?: number; rrf?: number }
  /** 命中块全文（只在检索测试与评测时返回，不写进上下文）。 */
  content?: string
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
  /** 每次运行的用量（与 usage 同口径，来自事件），需求行迷你柱与每日活动用。 */
  runUsage?: Record<RunId, Usage>
  leadTimeHours?: number
  /** 验收标准覆盖：每条 AC 有没有用例、用例过没过。 */
  acCoverage?: Array<{ ac: string; title: string; cases: number; passed: number; failed: number; status: 'covered' | 'partial' | 'uncovered' }>
  quality?: QualityMetrics
}

/**
 * 校验与拦截（docs/design/19）。
 * verified：通过的门禁检查（含交付校验）与通过的评审轮；intercepted：交付前被拦下的问题。
 */
export interface QualityMetrics {
  verified: number
  intercepted: number
  interceptedBy: {
    /** 未通过的门禁检查。 */
    gate: number
    /** 未通过评审轮里的 blocker / major 问题。 */
    review: number
    /** 判决为 product_bug 的失败。 */
    judge: number
    /** 完成标准未满足。 */
    completion: number
    /** 被失败指纹抑制的重复重试。 */
    fingerprint: number
  }
}

// ============================================================ 经验库（docs/design/19）

export interface Lesson {
  id: string
  title: string
  /** 正文：现象、原因、做法；召回时注入，≤ 600 token。 */
  body: string
  trigger: {
    roles?: string[]
    /** glob：节点写权限或输入路径命中其一即触发。 */
    paths?: string[]
    /** 错误签名（正则源码）：在打回意见 / 上次失败原因里命中即触发。 */
    signatures?: string[]
    categories?: VerdictCategory[]
  }
  /** tentative：试用（参与对照组）；active：启用；retired：退役（文件保留，不再召回）。 */
  status: 'tentative' | 'active' | 'retired'
  source: { kind: 'judge' | 'review' | 'human'; runId?: RunId; nodeId?: NodeId; ref?: string }
  /** 人明确写下的经验：直接启用，不进对照组。 */
  userStated?: boolean
  stats: { recalled: number; helped: number; hurt: number }
  createdAt: Timestamp
  updatedAt: Timestamp
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
  /** 职责标签（pm / rd / qa / arch ……）：节点 owner 匹配时待办派给此人。 */
  duties?: string[]
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
  /** worktree 建好后在其中执行的引导命令（如 npm ci）；失败则节点 blocked。 */
  bootstrap?: string
  /** 从仓库主检出软链进 worktree 的目录（如 node_modules），避免每个 worktree 重装。 */
  share?: string[]
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

export type RoomMessageKind = 'text' | 'system' | 'attention' | 'task' | 'artifact' | 'progress' | 'route'

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
  /** kind 为 route 时：路由卡内容。 */
  route?: RouteDecision
  /** kind 为 task 时：派发回执（docs/design/26 §4）。 */
  receipt?: { status: DelegationStatus; hops?: number; chain?: RunId[]; note?: string }
}

/** 转达 / 派发的回执状态；uncertain：发送过程出错、可能已送达，不自动重发。 */
export type DelegationStatus = 'sent' | 'taken' | 'started' | 'done' | 'replied' | 'refused' | 'expired' | 'uncertain'

/** Lead 当前在做什么（服务端按回合与运行状态推导，供状态灯显示）。 */
export interface LeadPresence {
  state: 'idle' | 'thinking' | 'working' | 'waiting'
  since: Timestamp
  /** 例如"正在派发 PM 任务""等 @alice 确认 PRD v3"。 */
  detail?: string
}

export interface Room {
  id: string
  requirementId: RequirementId
  title: string
  members: RoomMember[]
  createdAt: Timestamp
  /** 绑定的外部 IM 群（飞书 / Slack …）。 */
  external?: { kind: string; chatId: string }
  lead?: LeadPresence
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
  /** 对已有产物的修改是措辞调整还是语义变更（措辞调整不让下游过期）；缺省 semantic。 */
  impact?: 'cosmetic' | 'semantic'
  completion?: string[]
}

export type LeadAction =
  | { type: 'reply'; text: string; mentions?: string[] }
  | { type: 'dispatch_task'; task: TaskSpec }
  /** workflowId 为 'auto' 时先走路由器，并把路由卡发到群里。 */
  | { type: 'start_run'; workflowId: string; args?: Record<string, unknown>; budget?: RunBudget }
  | { type: 'resume_run'; runId: RunId }
  /** 重试失败 / 阻塞的节点后续跑；nodeIds 省略 = 全部失败和阻塞的节点。 */
  | { type: 'retry_run'; runId: RunId; nodeIds?: NodeId[] }
  | { type: 'cancel_run'; runId: RunId; reason: string }
  /** assumption / timebox 同 HumanNodeDef：只有 answer 带假设时才会到时交还（docs/design/26 §3）。 */
  | { type: 'request_human'; to: string; ask: string; form: HumanNodeDef['form']; choices?: string[]; assumption?: string; timebox?: HumanTimebox }
  | { type: 'propose_workflow_change'; workflowId: string; description: string; source?: string }
  | { type: 'update_notes'; content: string }
  /** 调用命令注册表里风险为 read 的命令（查询类）；写类命令走上面的专用动作。 */
  | { type: 'command'; id: string; input?: Record<string, unknown> }

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
  project: { name: string; description?: string; color?: string }
  /** 项目空间：id 用于多空间 serve 的路由。 */
  space?: { id: string }
  members?: SpaceMember[]
  /** 绑定的代码仓库。 */
  repos?: RepoBinding[]
  /** 目录约定；不写时新空间用顶层 agents/ workflows/ skills/ knowledge/ requirements/，旧项目沿用 .takt/ 下的目录。 */
  paths?: { agents?: string; workflows?: string; skills?: string; knowledge?: string; requirements?: string; evals?: string }
  sandbox?: { provider: 'local' | 'bwrap' | 'docker' | (string & {}); image?: string; network?: SandboxSpec['network'] }
  /** 需求群的 Lead Agent。maxHops：任务派任务的跳数上限（默认 10）；receiptTimeoutMinutes：派出的任务多久没人接手标为过期（默认 30）。 */
  lead?: { harness?: HarnessSelector; progressUpdates?: boolean; maxHops?: number; receiptTimeoutMinutes?: number }
  /** 等人的默认时限（节点可覆盖，docs/design/26 §3）。 */
  human?: HumanTimebox
  /** 回放评测（docs/design/21 §6）：每个样本每个变体重复次数（默认 3）、发布门槛。 */
  eval?: { repeats?: number; gate?: EvalGate }
  /** 路由器：用哪个模型判档；没有合适流程时的兜底流程。 */
  route?: { harness?: HarnessSelector; defaultWorkflow?: string }
  /** 默认预算（workflow 与启动参数可覆盖）。 */
  budget?: RunBudget
  /** 同一失败指纹在输入不变时允许出现的次数（默认 2，达到即停止重试）。 */
  retry?: { maxSameFailure?: number }
  /** 结构化输出（docs/design/31 §5）：校验不过时追问修正的次数，缺省 2，0 为不追问。 */
  output?: { repairs?: number }
  /** 经验库。 */
  lessons?: { enabled?: boolean; holdoutPercent?: number; maxRecall?: number; maxTokens?: number; learner?: HarnessSelector; dailyCalls?: number }
  /** 角色 → 默认 harness（AgentProfile 可覆盖）。 */
  roles?: Record<string, HarnessSelector>
  /** 已注册的 workflow 文件（相对项目根目录）。 */
  workflows: string[]
  /** 旧版知识源登记（docs/design/08）。新知识库见 knowledge/<id>/kb.json 与 knowledgeBindings，旧条目可迁移。 */
  knowledge?: Array<{ id: string; kind: string; options?: Record<string, unknown> }>
  /** 空间绑定的知识库（docs/design/23）。 */
  knowledgeBindings?: KnowledgeBinding[]
  /** 知识库默认值：嵌入模型（models 里 kind 为 embedding 的别名）、检索参数。 */
  knowledgeDefaults?: { embeddingModel?: string; retrieval?: Partial<KnowledgeRetrieval> }
  /** 管家在本空间的默认 harness（用户偏好可覆盖）。 */
  steward?: { harness?: HarnessSelector }
  /** 上下文预算（token），超过即在账本里标红并触发策略。 */
  contextBudgetTokens?: number
  /** 插件：npm 包名或相对路径。 */
  plugins?: string[]
  /** 额外注册的 harness（声明式 CLI 适配等）。 */
  harnesses?: Array<CliHarnessConfig | AcpHarnessConfig>
  /** 内置 harness 的覆盖（id → 覆盖项），设置页「模型与 Harness」可改。 */
  harnessOverrides?: Record<string, HarnessOverride>
  /** LLM API 提供方：id → 配置。 */
  providers?: Record<string, ProviderConfig>
  /** 模型别名：别名 → 配置。 */
  models?: Record<string, ModelConfig>
  /** 自动化：定时或事件触发，启动 workflow / 写汇报 / 发通知（docs/design/30 §4）。 */
  automations?: AutomationConfig[]
  /** 通知渠道：飞书 / Lark 机器人、Slack、通用 Webhook。地址与签名密钥只写环境变量名。 */
  channels?: ChannelConfig[]
}

// ============================================================ 自动化与通知渠道（docs/design/30 §4）

export type AutomationEvent = 'run.finished' | 'run.failed' | 'requirement.created' | 'attention.overdue'

export type AutomationTrigger =
  /** 5 段 cron（分 时 日 月 周），按 serve 所在机器的时区。 */
  | { schedule: string }
  | {
      event: AutomationEvent
      /** 只对这些 workflow / 需求生效；不写即全部。 */
      filter?: { workflowIds?: string[]; requirementIds?: string[] }
    }

export type AutomationAction =
  /** 对需求跑 workflow。事件触发时 requirementId 默认取事件里的需求；定时触发必须写。 */
  | { kind: 'start_workflow'; workflowId: string; requirementId?: string }
  /** 汇报：空间内各需求的最新进展、等人的事、失败的运行（同管家 digest，按需求去重）。since 不写时取上次成功执行以来，首次为 24 小时。 */
  | { kind: 'digest'; sinceHours?: number }
  /** 只发消息。text 可用 {{requirement.title}} {{run.id}} {{run.status}} {{node.id}} {{link}} 占位。 */
  | { kind: 'notify'; text: string }

export interface AutomationConfig {
  id: string
  title: string
  enabled: boolean
  trigger: AutomationTrigger
  action: AutomationAction
  /** 执行结果发到哪些渠道（ChannelConfig.id）。digest / notify 必须至少一个。 */
  notify?: { channels: string[] }
}

export interface ChannelConfig {
  id: string
  title?: string
  kind: 'feishu' | 'slack' | 'webhook'
  /** webhook 地址所在的环境变量名（或本机密钥库里的名字）。 */
  urlEnv: string
  /** 飞书机器人的签名校验密钥（可选）。 */
  secretEnv?: string
}

// ============================================================ 评测与归因（docs/design/20）

/** 节点一次执行的配方：用了哪个版本的角色、prompt、技能、模型。 */
export interface NodeRecipe {
  workflowId: string
  workflowVersion: string
  /** workflow 源码修订（workflow-source 的 rev）；拿不到时缺省。 */
  workflowRev?: string
  nodeId: NodeId
  kind: NodeKind
  role?: string
  /** 角色档案（agents/<role>.md）内容哈希。 */
  profileHash?: string
  /** prompt 模板哈希；动态 prompt 取函数源码的哈希。 */
  promptHash?: string
  /** 实际加载的技能及内容哈希（目录内全部文件按路径排序后的哈希）。 */
  skills: Array<{ name: string; hash: string }>
  harness?: string
  model?: string
  effort?: HarnessSelector['effort']
  /** 本次召回的经验 id（不计入 recipeKey）。 */
  lessons?: string[]
  /** 本次执行实际读到的输入产物版本（回放评测冻结输入用，不计入 recipeKey）。 */
  inputs?: ArtifactRef[]
  /** 除 lessons 外各字段规范化后的 sha256 前 16 位。 */
  recipeKey: string
}

export type DefectOrigin = 'requirement' | 'design' | 'implementation' | 'test_design' | 'automation' | 'environment' | 'external' | 'unknown'

/** 本该拦住却漏掉的原因。 */
export type MissReason = 'not_covered' | 'wrong_assertion' | 'reviewed_but_missed' | 'gate_absent' | 'judge_misclassified' | 'evidence_stale' | 'other'

/** 交付后发现的缺陷（存放区 defects/<id>.md，kind defect）。 */
export interface Defect {
  id: string
  requirementId: RequirementId
  title: string
  description: string
  severity: 'critical' | 'major' | 'minor'
  foundAt: Timestamp
  reportedBy: Actor
  /** 关联的验收标准 id。 */
  acs?: string[]
  links?: ExternalLink[]
  evidence?: string[]
  status: 'open' | 'attributed' | 'confirmed' | 'closed'
  /** 由哪些观察创建（docs/design/21 §4）。 */
  observations?: string[]
  /** 有效性与处理状态分开记；缺省按 M3 的 status 推断。 */
  validity?: 'unconfirmed' | 'valid' | 'not_defect' | 'duplicate'
  resolution?: 'open' | 'claimed_fixed' | 'verified_fixed' | 'accepted_risk' | 'reopened'
  duplicateOf?: string
  /** 读模型版本：更新时带 baseRevision，不一致返回 409。 */
  revision?: number
}

/** 归因：在哪引入、哪里漏检、怎么改。归因 Agent 给候选，人确认后才计入成绩单。 */
export interface DefectAttribution {
  defectId: string
  introducedAt: { origin: DefectOrigin; runId?: RunId; nodeId?: NodeId; artifact?: ArtifactRef; evidence: string[] }
  missedBy: Array<{ runId?: RunId; nodeId: NodeId; reason: MissReason; evidence: string[] }>
  confidence: number
  suggestions: Array<{ target: { kind: 'skill' | 'prompt' | 'completion' | 'review_focus' | 'gate_check' | 'lesson' | 'knowledge'; ref: string }; change: string }>
  /** 确定性预检结果（不花 token）。 */
  precheck: { acCovered?: boolean; cases?: string[]; codeNodes?: NodeId[]; reviewedBy?: NodeId[]; gates?: NodeId[] }
  by: Actor
  at: Timestamp
  confirmed?: { by: Actor; at: Timestamp; note?: string; edited: boolean }
  /** 逐检查点的漏检结论（docs/design/21 §4，替代 missedBy 的 reason；missedBy 保留兼容）。 */
  checkpoints?: MissAssessment[]
}

export type EvalTarget = { kind: 'node'; workflowId: string; nodeId: string } | { kind: 'skill'; name: string }

/** 回放评测用例：冻结输入 + 被测节点定义 + 判分规则（evals/<目标>/<id>.json）。 */
export interface EvalCase {
  id: string
  target: EvalTarget
  title: string
  source: { kind: 'history' | 'defect' | 'skill' | 'manual'; runId?: RunId; nodeId?: NodeId; defectId?: string }
  node: SnapshotNode
  /** 当时实际渲染的 prompt（动态 prompt 回放用它）。 */
  prompt?: string
  inputs: Array<{ path: string; content: string; kind?: ArtifactKind }>
  grading: {
    /** 由独立 verifier 逐条核对的完成标准。 */
    checks?: string[]
    /** 在输出目录里执行的确定性命令（退出码 0 为过）。 */
    commands?: string[]
    rubric?: { text: string; threshold: number; judge?: HarnessSelector }
    /** 参考答案（评审与人工修改后的最终版本）。 */
    reference?: { path: string; content: string }
    /** 回归：必须指出 / 不得引入的问题描述。 */
    mustFind?: string[]
    mustNotIntroduce?: string[]
  }
  createdAt: Timestamp
  /**
   * 检查点样本（docs/design/21 §6）：must_catch 来自确认的漏检（期望提出某个问题），
   * clean 来自人确认无问题的评审调用（不应提出 blocker / major）。缺省为 M3 的节点用例。
   */
  sample?: { kind: 'must_catch' | 'clean'; checkpointId: string; snapshot: string; expectIssue?: string; retiredAt?: Timestamp }
}

/** 被比较的版本：在基线配方上覆盖哪些项。 */
export interface EvalVariant {
  id: string
  label: string
  /** 用这个目录替换空间技能目录。 */
  skillsDir?: string
  /** 用这个文件的内容替换节点 prompt。 */
  promptFile?: string
  /** 用这个文件替换角色档案。 */
  profileFile?: string
  harness?: HarnessSelector
}

export interface EvalCaseResult {
  caseId: string
  variant: string
  pass: boolean
  /** 0–100。 */
  score?: number
  checks?: CompletionCheck[]
  rubric?: { score: number; reason: string }
  /** 与参考答案的一致程度（0–100，由 judge 给出）。 */
  reference?: { score: number; reason: string }
  usage: Usage
  durationMs: number
  error?: string
  /** 输出快照的存放路径（.takt/evals/runs/<run>/<case>/<variant>/）。 */
  outputDir?: string
}

export interface EvalComparison {
  baseline: string
  candidate: string
  /** 逐用例结果（规则见 docs/dev/m3-eval.md 第 5 条），前端直接展示，不再自行推算。 */
  cases?: Array<{ caseId: string; outcome: 'win' | 'loss' | 'tie' }>
  wins: number
  losses: number
  ties: number
  passRate: Record<string, number>
  meanScore: Record<string, number>
  /** 回归用例（来源为 defect）在候选版本上没过的。 */
  regressionsFailed: string[]
  verdict: 'better' | 'worse' | 'same' | 'inconclusive'
}

export interface EvalRun {
  id: string
  target: EvalTarget
  variants: EvalVariant[]
  caseIds: string[]
  /** refused：隔离校验不通过，没有启动（原因见 isolation.reasons）。 */
  status: 'running' | 'done' | 'failed' | 'refused'
  /** 隔离校验（docs/design/21 §5）：simulated 只用于 mock harness，报告里显式标注。 */
  isolation?: { ok: boolean; mode?: 'sandbox' | 'harness_readonly' | 'simulated'; reasons?: string[] }
  /** 变体 id → 不可变候选包 id（.takt/quality/candidates/<id>/）。 */
  candidates?: Record<string, string>
  repeats?: number
  report?: EvalReport
  /** 开始时冻结的样本副本与评委候选包 id；报告只依据它们，之后样本退役或改动不影响这次结果。 */
  frozenCases?: EvalCase[]
  judgeCandidate?: string
  /** 逐次证据：每个样本 × 变体 × 第几次重复一条。 */
  replayEvidence?: EvalReplayEvidence[]
  startedAt: Timestamp
  endedAt?: Timestamp
  by: Actor
  results: EvalCaseResult[]
  comparison?: EvalComparison
}

/** 一次回放的证据：结论、输出、误报、评委调用与本次所有调用身份。 */
export interface EvalReplayEvidence {
  caseId: string
  variant: string
  repeat: number
  verdict: { outcome: 'pass' | 'fail' | 'insufficient'; reason?: string; falsePositive?: boolean; invocationId?: string }
  result?: EvalCaseResult
  output?: unknown
  /** clean 样本提出了 blocker / major。 */
  falsePositive?: boolean
  judgeInvocationId?: string
  invocations: Invocation[]
}

// ============================================================ 归因可信度（docs/design/21）

/** 检查点在调用里的分工。 */
export type CheckpointRole = 'producer' | 'author' | 'reviewer' | 'arbiter' | 'rubric' | 'acceptance' | 'command' | 'judge' | 'planner' | 'auditor' | 'evaluator'

/**
 * 检查点：评审者 / 作者修改 / 裁决者 / 门禁检查项 / auditor / evaluator 的一次判断。
 * 调度时分配身份（checkpoint.scheduled），没执行（出错、被跳过）的也能在归因里引用。
 */
export interface Checkpoint {
  /** `<runId>:<nodeId>:<attempt>:<修订>.<轮>:<评审者或检查项>`；没有修订 / 轮的节点写 1.1。 */
  id: string
  runId: RunId
  nodeId: NodeId
  attempt: number
  revision?: number
  round?: number
  role: CheckpointRole
  /** 评审者角色名或检查项 id。 */
  subject: string
  /** 职责条目：评审者 checklist、rubric 条目、检查项标题。 */
  duties?: string[]
  scheduledAt: Timestamp
}

/** 检查点的只读快照清单（.takt/snapshots/<runId>/<检查点安全名>/manifest.json）。 */
export interface SnapshotManifest {
  checkpointId: string
  /** 相对 .takt/ 的快照目录。 */
  dir: string
  files: Array<{
    /** 快照内的相对路径。 */
    path: string
    /** target：被评审对象；reference：比较依据。 */
    role: 'target' | 'reference'
    /** artifact：存放区产物版本；diff：仓库改动；file：仓库文件。 */
    source: 'artifact' | 'diff' | 'file'
    ref?: ArtifactRef
    repo?: string
    commit?: string
    sha256: string
    size: number
  }>
  duties: string[]
  /** 只读如何保证：沙箱只读挂载 / 文件权限 / 做不到（如实记录，归因只能声称"提供了这些版本"）。 */
  readOnly: 'sandbox' | 'permissions' | 'none'
  createdAt: Timestamp
}

/** 模型 / effort 的三层取值：配方请求、引擎解析、harness 回报；applied 为 false 表示适配器不支持覆盖。 */
export interface ResolvedValue<T> {
  requested?: T
  resolved?: T
  reported?: T
  applied?: boolean
}

/** 一次 HarnessAdapter.run 尝试（fallback 的每个候选各一次；harness 内部多轮请求只计用量；健康探测不记）。 */
export interface InvocationStart {
  id: string
  nodeId: NodeId
  attempt: number
  checkpointId?: string
  role: CheckpointRole
  /** 角色档案名。 */
  agentRole?: string
  /** fallback 链里的序号（0 为首选）。 */
  fallbackIndex: number
  recipeKey?: string
  harness: string
  model: ResolvedValue<string>
  effort: ResolvedValue<string>
  /** declared：角色声明；providedHash：实际同步进 harness 技能目录的内容哈希；confirmed：harness 事件能证明加载。 */
  skills: Array<{ name: string; providedHash?: string; confirmed: 'yes' | 'no' | 'unknown' }>
  readOnly?: boolean
  /** 接的 provider（config.providers 的键）；没有时是 harness 自带。 */
  provider?: string
  /** harness 与 LLM API 怎么接上的（docs/design/31 §2）。 */
  pairing?: Pairing
  /** 结构化输出没通过校验后的第几次修正追问（docs/design/31 §5）；正常调用缺省。 */
  repair?: number
  at: Timestamp
}

export interface InvocationEnd {
  id: string
  outcome: 'ok' | 'error' | 'cancelled'
  error?: string
  usage?: Usage
  sessionId?: string
  /** harness 回报的实际值（补进 InvocationStart 的 reported 与 skills.confirmed）。 */
  reported?: { model?: string; effort?: string; skills?: string[] }
  durationMs: number
}

export type Invocation = InvocationStart & Partial<Omit<InvocationEnd, 'id'>>

/** 观察的来源与种类（docs/design/21 §4）。 */
export type ObservationSource = 'review' | 'judge' | 'gate' | 'human' | 'external'
export type ObservationKind =
  | 'finding' // 评审提出问题
  | 'claimed_fixed' // 作者声称已修
  | 'verified_fixed' // 评审者复查 resolved
  | 'declined' // 作者不采纳
  | 'waived' // 人工放行
  | 'failure' // 判决：某个对象失败
  | 'ignored' // 判决路由为 ignore
  | 'flaky' // 判决：不稳定
  | 'gate_fail'
  | 'gate_error' // 检查本身出错：流程问题，不算产物缺陷
  | 'report' // 人工 / 外部缺陷单

/** 观察：不可变，"某个来源在某个时刻对某个对象说了什么"；按源事件幂等入账。 */
export interface Observation {
  /** 幂等键 `<来源>:<runId>:<seq>:<序号>`（人工 / 外部为 `<来源>:<uuid>`）。 */
  id: string
  source: ObservationSource
  kind: ObservationKind
  requirementId: RequirementId
  runId?: RunId
  nodeId?: NodeId
  checkpointId?: string
  invocationId?: string
  /** 问题键 / 用例 id / 检查项 id。 */
  subject?: string
  severity?: ReviewIssue['severity'] | Defect['severity']
  title: string
  detail?: string
  artifacts?: ArtifactRef[]
  /** 已被哪些缺陷引用（读模型计算）。 */
  defects?: string[]
  at: Timestamp
  by: Actor
}

/** 漏检判定（替代 M3 的 MissReason）。 */
export type MissVerdict =
  | 'should_have_caught' // 本该拦住：五项条件同时满足
  | 'caught_but_waived' // 拦住了但被不采纳 / 人工放行
  | 'material_missing' // 相关材料不在快照清单里
  | 'not_executed' // 检查点没执行或出错
  | 'out_of_scope' // 职责条目明确不包含
  | 'undetermined' // 以上都证明不了

export interface MissAssessment {
  checkpointId: string
  runId: RunId
  nodeId: NodeId
  verdict: MissVerdict
  /** 五项条件：①缺陷当时已存在 ②材料在快照里 ③在职责内 ④执行完成 ⑤输出没提出；undefined = 证明不了。 */
  conditions: { existed?: boolean; materialProvided?: boolean; inDuty?: boolean; executed?: boolean; notRaised?: boolean }
  evidence: string[]
  /** precheck：确定性算出（②④ 与没给材料 / 没执行）；auditor：建议；human：人改判。 */
  by: 'precheck' | 'auditor' | 'human'
  confirmed?: { by: Actor; at: Timestamp; note?: string }
}

/** 合并建议：只给建议，人确认，可撤销。 */
export interface DefectMergeSuggestion {
  id: string
  defects: string[]
  reason: string
  status: 'suggested' | 'accepted' | 'rejected' | 'undone'
  decidedBy?: Actor
  at: Timestamp
}

/** 发布门槛（预先规定，报告按它给结论；不允许事后改规则复用旧报告：报告里存门槛快照）。 */
export interface EvalGate {
  minSamples: number
  minRepeats: number
  /** 允许的通过率下降（0–1）。 */
  maxPassRateDrop: number
  /** 允许增加的误报次数。 */
  maxFalsePositiveIncrease: number
  regressionsMustPass: boolean
}

/** 检查点回放报告：每次结论为通过 / 失败 / 证据不足（环境错误、无法回放、评委判不了都算证据不足，不算通过）。 */
export interface EvalReport {
  samples: Array<{
    caseId: string
    kind: 'must_catch' | 'clean' | 'node'
    variants: Record<string, { pass: number; fail: number; insufficient: number; falsePositives: number; runs: Array<{ outcome: 'pass' | 'fail' | 'insufficient'; reason?: string; falsePositive?: boolean; invocationId?: string }> }>
  }>
  /** 通过率与 Wilson 95% 区间（分母 = 通过 + 失败，不含证据不足）。 */
  passRate: Record<string, { rate: number; low: number; high: number; n: number }>
  falsePositives: Record<string, number>
  insufficient: Record<string, number>
  /** 样本数或重复次数低于门槛：只作探索，不作发布依据。 */
  exploratory: boolean
  gate?: { verdict: 'pass' | 'fail' | 'not_applicable'; reasons: string[]; config: EvalGate }
  /** 评委配方与是否盲评（隐藏组别、按哈希打乱顺序）。 */
  judge?: { recipeKey?: string; blind: boolean }
}

/** 质量日志（.takt/quality/log.jsonl）：缺陷、归因、样本、评测的唯一权威记录，复用事件存储的哈希链与锚点。 */
export type QualityLogKind =
  | 'observation.recorded'
  | 'defect.created'
  | 'defect.updated'
  | 'attribution.recorded'
  | 'attribution.confirmed'
  | 'merge.suggested'
  | 'merge.decided'
  | 'sample.added'
  | 'sample.retired'
  | 'eval.started'
  | 'eval.finished'
  /** 评测回放里的 harness 调用身份（docs/design/21 §2、§5）：开始 / 结束各一条。 */
  | 'invocation.started'
  | 'invocation.finished'
  | 'recovery'

export interface QualityLogEntry {
  seq: number
  ts: Timestamp
  kind: QualityLogKind
  /** 幂等键：同键只入账一次。 */
  key: string
  requirementId?: RequirementId
  data: unknown
  actor: Actor
  prevHash: string
  hash: string
}

// ============================================================ 运行透明与回退（docs/design/26）

/** 节点开始前的文件状态：仓库 worktree HEAD 与将要写的产物的当前版本。 */
export interface RewindPoint {
  repos?: Array<{ repo: string; path: string; head: string }>
  artifacts?: ArtifactRef[]
  at: Timestamp
}

// ============================================================ 知识库（docs/design/23）

export type KnowledgeKindId = 'rag' | 'llm-wiki' | 'database' | 'api' | 'code' | 'history' | (string & {})

export interface KnowledgeRetrieval {
  topK: number
  /** 低于此分（0–1 归一化后）的命中丢弃。 */
  minScore?: number
  /** 混合检索权重（rag）；没有嵌入模型时 vector 视为 0。 */
  hybrid?: { bm25: number; vector: number }
  /** rerank 模型别名；不写不 rerank。 */
  rerank?: string
  /** 一次查询写进上下文的 token 上限。 */
  budgetTokens: number
}

export interface KnowledgeBase {
  id: string
  name: string
  kind: KnowledgeKindId
  /** 给路由器和人看：能回答什么、不能回答什么。 */
  description: string
  intents: KnowledgeIntent[]
  /** space：在空间 knowledge/<id>/；shared：在 spaces 根目录 .shared/knowledge/<id>/，可被多个空间绑定。 */
  scope: 'space' | 'shared'
  /** 按 kind 的 configSchema 校验；密钥字段只存引用（${env:NAME} 或 secret:<name>）。 */
  config: Record<string, unknown>
  retrieval: KnowledgeRetrieval
  status: 'draft' | 'building' | 'ready' | 'stale' | 'error'
  /** 已发布版本；0 表示还没发布。运行时只用已发布版本。 */
  version: number
  /** 最近一次成功构建、尚未发布的版本。 */
  candidateVersion?: number
  builtAt?: Timestamp
  publishedAt?: Timestamp
  stats?: { docs: number; chunks: number; bytes: number; tables?: number; operations?: number; pages?: number }
  /** status 为 error 时的原因。 */
  error?: string
  createdAt: Timestamp
  updatedAt: Timestamp
  createdBy: Actor
}

export interface KnowledgeBinding {
  baseId: string
  scope: 'space' | 'shared'
  enabled: boolean
  /** 数字越小越优先（合并同分时）。 */
  priority: number
  /** 覆盖知识库自己的 intents。 */
  intents?: KnowledgeIntent[]
  /** 只允许这些角色使用；不写即全部。 */
  roles?: string[]
}

export interface KnowledgeBuildStage {
  id: 'parse' | 'chunk' | 'embed' | 'index' | 'snapshot' | 'generate' | (string & {})
  title: string
  done: number
  total: number
  status: 'todo' | 'running' | 'done' | 'failed' | 'skipped'
}

export interface KnowledgeBuild {
  id: string
  baseId: string
  /** 本次构建产出的版本号。 */
  version: number
  status: 'running' | 'succeeded' | 'failed' | 'cancelled'
  startedAt: Timestamp
  endedAt?: Timestamp
  by: Actor
  stages: KnowledgeBuildStage[]
  /** 最近 200 行日志。 */
  log: string[]
  errors?: Array<{ ref: string; message: string }>
  stats?: KnowledgeBase['stats']
  /** llm-wiki 从代码仓库生成时，对应的 workflow 运行（可追溯、可评审）。 */
  runId?: RunId
}

export type KnowledgeEvalSource = 'manual' | 'synthetic' | 'harvested' | 'defect'

export interface KnowledgeEvalCase {
  id: string
  query: string
  intent?: KnowledgeIntent
  /** 分级相关性：3 完全相关，2 部分相关，1 沾边。 */
  relevant: Array<{ ref: string; grade: 1 | 2 | 3 }>
  /** 期望事实（数据库 / 接口：期望结果的关键值）。 */
  answer?: string
  source: KnowledgeEvalSource
  /** 线上采集 / 合成的用例在人确认前为 candidate，不参与发布门槛。 */
  status: 'active' | 'candidate' | 'retired'
  createdAt: Timestamp
  createdBy: Actor
}

export interface KnowledgeEvalMetrics {
  n: number
  recall5: number
  recall10: number
  precision5: number
  mrr: number
  ndcg10: number
  /** top k 里至少一条相关的比例。 */
  hitRate: number
  emptyRate: number
  latencyP50: number
  latencyP95: number
  tokensPerQuery?: number
  /** database：SQL 执行成功率、结果正确率、守卫拦截次数。 */
  sqlSuccess?: number
  resultAccuracy?: number
  blocked?: number
  /** api：选对操作的比例、调用成功率。 */
  opAccuracy?: number
  callSuccess?: number
}

export type KnowledgeMissDiagnosis = 'ok' | 'no_doc' | 'not_retrieved' | 'low_rank'

export interface KnowledgeEvalVariant {
  id: string
  label: string
  /** 用哪个版本的索引；不写为候选版本（没有则已发布版本）。 */
  version?: number
  retrieval?: Partial<KnowledgeRetrieval>
}

export interface KnowledgeEvalRun {
  id: string
  baseId: string
  setId: string
  variants: KnowledgeEvalVariant[]
  status: 'running' | 'done' | 'failed'
  startedAt: Timestamp
  endedAt?: Timestamp
  by: Actor
  metrics: Record<string, KnowledgeEvalMetrics>
  perCase: Array<{ caseId: string; variant: string; firstRelevantRank?: number; found: string[]; missed: string[]; diagnosis: KnowledgeMissDiagnosis; latencyMs: number }>
  /** 有两个变体时：第一个为基线。统计口径同 docs/design/21（成对胜负 + Wilson 区间）。 */
  comparison?: {
    baseline: string
    candidate: string
    wins: number
    losses: number
    ties: number
    recall10Delta: number
    interval?: [number, number]
    verdict: 'better' | 'worse' | 'same' | 'inconclusive'
  }
  error?: string
}
