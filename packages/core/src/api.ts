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
 */
import type { AttentionItem } from './interfaces.js'
import type {
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
  StageDef,
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
  graph: { nodes: GraphNode[]; edges: GraphEdge[] }
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
  events: EventEnvelope[]
}

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

export type { AttentionItem, RequirementMetrics }
