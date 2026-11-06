/**
 * 缺陷归因与改进验证的协议（docs/design/19，一期）。
 *
 * 一期范围：文档类评审的调用记录、观察与缺陷、人工归因、单个只读评审者调用的回放。
 * 所有质量事实来自空间质量日志（.takt/quality/log.jsonl）；本文件里的 *View 都是可重建的读模型。
 */
import type { Actor, ArtifactRef, NodeId, RequirementId, RunId, Timestamp, Usage } from './types.js'

// ============================================================ 身份：配方 / 调用 / 输入快照（2.1）

/** 一个可替换、可比较的资产版本：角色档案、Skill、职责模板等。 */
export interface AssetRef {
  kind: 'file' | 'plugin' | 'inline'
  /** 文件：相对空间根的路径；插件：<包名>@<版本>#<名称>；内联：定义处的稳定名称。 */
  id: string
  sha256: string
  revision?: string
}

/** 配方内容版本：只含静态、可复用的部分。相同配方 → 相同 recipeId。 */
export interface Recipe {
  recipeId: string
  role: string
  profile: AssetRef
  skills: AssetRef[]
  /** 节点 prompt 模板或评审职责（focus / checklist / rubric）。 */
  template: AssetRef
  harness: string
  provider?: string
  model?: string
  effort?: string
  /** 输出 schema 的 sha256。 */
  outputSchema?: string
}

/** 评审调用在节点里的角色。 */
export interface InvocationReviewPart {
  round: number
  part: 'author' | 'reviewer'
  reviewer?: string
}

/**
 * 一次工作流 HarnessAdapter.run 尝试（不是一次模型请求）。
 * harness 内部多轮模型请求只计入 usage；available() 健康探测不记。
 */
export interface Invocation {
  /** `<runId>:<seq>`，seq 是 invocation.started 事件的序号。 */
  invocationId: string
  runId: RunId
  nodeId: NodeId
  attempt: number
  iteration?: number
  review?: InvocationReviewPart
  /** 检查点身份（评审者 / rubric 门禁），见 CheckpointRef。 */
  checkpointId?: string
  gateCheckId?: string
  /** 第几个候选 harness（0 = 首选）。 */
  fallbackIndex: number
  recipeId: string
  inputSnapshotId: string
  resolved: { harness: string; model?: string; effort?: string }
  reported?: { model?: string; sessionId?: string }
  outcome?: { status: 'ok' | 'error' | 'cancelled'; usage?: Usage; error?: string }
  /** full：可等价回放；limited：脱敏或缺材料导致受限；none：不可回放。 */
  replay: 'full' | 'limited' | 'none'
  /** 不可回放 / 受限的原因（例如"脱敏改写了请求""动态 prompt 无法重建"）。 */
  replayNotes?: string[]
}

/** 本次调用的输入与最终请求快照；正文都在对象存储（.takt/objects），这里只放对象 id。 */
export interface InputSnapshot {
  inputSnapshotId: string
  request: { prompt: string; systemAppend?: string; schema?: string }
  inputs: Array<{ ref: ArtifactRef; sha256: string; object: string; role: 'target' | 'reference' | 'input' }>
  knowledge?: Array<{ source: string; ref: string; object: string }>
  /** 实际提供给 harness 的技能目录内容清单。 */
  skillsProvided?: AssetRef[]
  cwdLayout: { root: string; paths: Record<string, string> }
  /** 脱敏处数；>0 时 replay 至少为 limited。 */
  redactions: number
  render: {
    rendererVersion: string
    template: { kind: 'node-prompt' | 'review-reviewer' | 'review-author' | 'rubric'; object: string }
    /** 结构化参数对象（评审：被评审对象、参考依据、checklist、已有问题清单、轮次）。 */
    params: string
    assets: Array<AssetRef & { object: string }>
    /** 工具 / 权限 / 环境变量名（不含值）。 */
    exec: { adapter: string; adapterVersion: string; tools: string[]; permissions: string; env: string[] }
  }
}

/** Skill 的使用状态：声明 → 提供 → 确认加载；观察不到记 unknown。 */
export type SkillUse = 'declared' | 'provided' | 'confirmed' | 'unknown'

// ============================================================ 检查点（2.7）

/** 检查点身份：调度时就分配；未执行的检查点没有 invocation 也能被引用。 */
export interface CheckpointRef {
  /** `<runId>:<nodeId>:<attempt>:<round>:<reviewer | checkId>` */
  checkpointId: string
  runId: RunId
  nodeId: NodeId
  attempt: number
  round?: number
  reviewer?: string
  checkId?: string
  /** 冻结的材料：被评审对象与参考依据（只读快照的产物版本）。 */
  materials: Array<{ ref: ArtifactRef; sha256: string; role: 'target' | 'reference' }>
  /** 职责版本：focus / checklist / rubric。 */
  duty?: AssetRef
  status: 'scheduled' | 'completed' | 'error' | 'skipped'
  invocationId?: string
}

// ============================================================ 观察与缺陷（2.4、2.5）

export type ObservationSource = 'review' | 'judge' | 'gate' | 'human' | 'external'
export type ObservationKind = 'found' | 'claimed_fixed' | 'verified_fixed' | 'still_open' | 'declined' | 'overridden' | 'error' | 'flaky' | 'ignored'

/** 不可变的观察记录。id 即幂等键：`<source>:<runId>:<seq>:<itemIndex>`。 */
export interface Observation {
  id: string
  source: ObservationSource
  kind: ObservationKind
  requirementId: RequirementId
  invocationId?: string
  checkpointId?: string
  runId?: RunId
  nodeId?: NodeId
  attempt?: number
  round?: number
  subject: { artifact?: ArtifactRef; testCase?: string; checkId?: string; location?: string }
  /** 系统管理的问题身份 ISS-<n>。 */
  issueKey?: string
  severity?: 'blocker' | 'major' | 'minor' | 'nit'
  text: string
  evidence: string[]
  at: Timestamp
}

export type DefectValidity = 'unconfirmed' | 'valid' | 'not_a_defect' | 'duplicate'
export type DefectResolution = 'open' | 'claimed_fixed' | 'verified_fixed' | 'accepted_risk' | 'reopened'

export interface DefectView {
  id: string
  requirementId: RequirementId
  title: string
  severity: 'blocker' | 'major' | 'minor'
  observations: string[]
  validity: DefectValidity
  resolution: DefectResolution
  duplicateOf?: string
  attribution?: AttributionView
  /** 乐观并发：每次修改 +1；写操作必须带 baseRevision。 */
  revision: number
  createdBy: Actor
  createdAt: Timestamp
  updatedAt: Timestamp
}

// ============================================================ 归因与漏拦（2.6、2.7）

export type DefectCategory = 'requirement' | 'design' | 'test_design' | 'code' | 'automation' | 'knowledge' | 'environment' | 'process'

export type EscapeVerdict = 'should_have_caught' | 'caught_but_overridden' | 'not_exposed' | 'not_executed' | 'out_of_scope' | 'undetermined'

export interface Escape {
  checkpointId: string
  invocationId?: string
  runId: RunId
  nodeId: NodeId
  attempt: number
  round?: number
  reviewer?: string
  checkId?: string
  humanRequestId?: string
  verdict: EscapeVerdict
  rationale: string
  evidence: string[]
}

export interface AttributionView {
  status: 'candidate' | 'confirmed' | 'disputed' | 'unknown'
  category?: DefectCategory
  injected?: { invocationId?: string; artifact: ArtifactRef; previous?: ArtifactRef; human?: boolean; diffEvidence: string }
  escapes: Escape[]
  candidates: Array<{ invocationId?: string; artifact: ArtifactRef; reason: string }>
  method: 'human' | 'agent_suggested'
  rationale: string
  evidence: string[]
  by: Actor
  at: Timestamp
}

// ============================================================ 评测：样本、候选包、回放、报告（2.9、2.10）

export interface EvalCaseView {
  id: string
  revision: number
  kind: 'must_catch' | 'clean'
  origin?: { defectId?: string; invocationId: string }
  target: { role: string; template: AssetRef }
  frozen: { invocationId: string; inputSnapshotId: string }
  expectation:
    | { kind: 'must_catch'; issue: string; issueKey?: string }
    | { kind: 'clean'; allowedSeverities: Array<'minor' | 'nit'> }
  status: 'proposed' | 'active' | 'retired'
}

/** 实验专属不可变候选包；不写回正式空间。 */
export interface Candidate {
  candidateId: string
  replaces: Array<{ asset: AssetRef; content: string }>
  params?: Record<string, unknown>
  exec?: { model?: string; effort?: string }
  createdBy: Actor
  note: string
  createdAt: Timestamp
}

export type SampleOutcome = 'pass' | 'fail' | 'insufficient'

export interface EvalReportView {
  evalId: string
  candidateId: string
  /** baseline 为原配方（origin）或另一个候选包。 */
  baseline: 'origin' | string
  evalSetRevision: string
  judgeRecipeId: string
  samples: number
  cases: Array<{
    caseId: string
    baseline: SampleOutcome[]
    candidate: SampleOutcome[]
    /** clean 样本上提出 blocker / major 的次数。 */
    falsePositives: { baseline: number; candidate: number }
    notes: string[]
  }>
  /** 一期固定为 exploratory：不作为发布证明。 */
  kind: 'exploratory'
  status: 'running' | 'done' | 'error'
  startedAt: Timestamp
  finishedAt?: Timestamp
}

// ============================================================ 质量日志事件（2.8）

export interface QualityEventPayloads {
  'observation.recorded': Observation
  'defect.created': { defect: Omit<DefectView, 'attribution' | 'revision' | 'updatedAt'> }
  'defect.updated': {
    id: string
    baseRevision: number
    patch: Partial<Pick<DefectView, 'title' | 'severity' | 'validity' | 'resolution' | 'duplicateOf'>> & { addObservations?: string[]; removeObservations?: string[] }
    reason: string
    by: Actor
  }
  'attribution.recorded': { defectId: string; baseRevision: number; attribution: AttributionView }
  'evalcase.added': { case: EvalCaseView }
  'evalcase.updated': { id: string; baseRevision: number; status: EvalCaseView['status']; reason: string; by: Actor }
  'candidate.created': { candidate: Candidate }
  'eval.started': { evalId: string; candidateId: string; baseline: 'origin' | string; caseIds: string[]; samples: number; judgeRecipeId: string; by: Actor }
  'eval.sample': { evalId: string; caseId: string; arm: 'baseline' | 'candidate'; index: number; outcome: SampleOutcome; invocationId?: string; judgeInvocationId?: string; falsePositive?: boolean; note?: string }
  'eval.finished': { evalId: string; status: 'done' | 'error'; error?: string }
  /** 处理器游标推进（与质量事件同一次提交之后写）。 */
  'cursor.advanced': { runId: RunId; seq: number; processor: string; processorVersion: string }
  /** `takt quality repair` 补齐锚点。 */
  'log.recovered': { seq: number; reason: string }
}

export type QualityEventType = keyof QualityEventPayloads
