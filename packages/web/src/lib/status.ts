import {
  Ban,
  Check,
  Circle,
  CircleDashed,
  Clock,
  History,
  Layers,
  LoaderCircle,
  Network,
  Pause,
  Repeat,
  Scale,
  ShieldCheck,
  SkipForward,
  SquareTerminal,
  UserRound,
  X,
  type LucideIcon,
} from 'lucide-react'
import { BeeGlyph } from '../components/bee-glyph'
import type {
  ArtifactKind,
  ContextSource,
  NodeKind,
  NodeStatus,
  RequirementStatus,
  RunStatus,
  StageStatus,
  VerdictCategory,
} from '@taktflow/core'

/** 状态色语义：所有状态最终都落到这 7 种色调之一。 */
export type Tone = 'success' | 'running' | 'failed' | 'waiting' | 'stale' | 'skipped' | 'pending'

export interface StatusMeta {
  label: string
  tone: Tone
  icon: LucideIcon
  spin?: boolean
}

export const NODE_STATUS: Record<NodeStatus, StatusMeta> = {
  pending: { label: '未开始', tone: 'pending', icon: Circle },
  ready: { label: '就绪', tone: 'pending', icon: CircleDashed },
  running: { label: '运行中', tone: 'running', icon: LoaderCircle, spin: true },
  succeeded: { label: '成功', tone: 'success', icon: Check },
  failed: { label: '失败', tone: 'failed', icon: X },
  blocked: { label: '阻塞', tone: 'failed', icon: Ban },
  waiting_human: { label: '等人处理', tone: 'waiting', icon: Pause },
  skipped: { label: '跳过', tone: 'skipped', icon: SkipForward },
  stale: { label: '已过期', tone: 'stale', icon: History },
  cancelled: { label: '已取消', tone: 'skipped', icon: Ban },
}

export const RUN_STATUS: Record<RunStatus, StatusMeta> = {
  running: { label: '运行中', tone: 'running', icon: LoaderCircle, spin: true },
  succeeded: { label: '已完成', tone: 'success', icon: Check },
  failed: { label: '失败', tone: 'failed', icon: X },
  waiting_human: { label: '等人处理', tone: 'waiting', icon: Pause },
  cancelled: { label: '已取消', tone: 'skipped', icon: Ban },
}

export const REQ_STATUS: Record<RequirementStatus, StatusMeta> = {
  draft: { label: '草稿', tone: 'pending', icon: CircleDashed },
  active: { label: '进行中', tone: 'running', icon: Clock },
  blocked: { label: '阻塞', tone: 'failed', icon: Ban },
  delivered: { label: '已交付', tone: 'success', icon: Check },
  archived: { label: '已归档', tone: 'skipped', icon: Ban },
}

export const STAGE_STATUS: Record<StageStatus, StatusMeta> = {
  todo: { label: '未开始', tone: 'pending', icon: Circle },
  running: { label: '进行中', tone: 'running', icon: LoaderCircle, spin: true },
  done: { label: '已完成', tone: 'success', icon: Check },
  failed: { label: '失败', tone: 'failed', icon: X },
  waiting_human: { label: '等人处理', tone: 'waiting', icon: Pause },
}

export const NODE_KIND: Record<NodeKind, { label: string; icon: LucideIcon }> = {
  script: { label: '脚本', icon: SquareTerminal },
  agent: { label: 'Agent', icon: BeeGlyph },
  gate: { label: '门禁', icon: ShieldCheck },
  human: { label: '人工', icon: UserRound },
  judge: { label: '判决', icon: Scale },
  loop: { label: '循环', icon: Repeat },
  planner: { label: '规划', icon: Network },
  review: { label: '评审', icon: ShieldCheck },
  subflow: { label: '子流程', icon: Layers },
}

export const VERDICT: Record<VerdictCategory, { label: string; color: string; owner: string }> = {
  product_bug: { label: '代码缺陷', color: 'var(--c-8)', owner: '开发' },
  case_defect: { label: '用例缺陷', color: 'var(--c-4)', owner: '测试设计' },
  script_defect: { label: '脚本缺陷', color: 'var(--c-1)', owner: '自动化' },
  env_issue: { label: '环境问题', color: 'var(--c-2)', owner: '执行底座' },
  flaky: { label: '不稳定', color: 'var(--c-7)', owner: '重跑' },
  requirement_gap: { label: '需求缺口', color: 'var(--c-6)', owner: '产品 / 人' },
  test_data: { label: '测试数据', color: 'var(--c-3)', owner: '数据准备' },
  deployment: { label: '部署问题', color: 'var(--c-2)', owner: '发布' },
  permission: { label: '权限问题', color: 'var(--c-6)', owner: '人' },
  external_dependency: { label: '外部依赖', color: 'var(--c-7)', owner: '等待外部' },
  unknown: { label: '无法判定', color: 'var(--c-5)', owner: '人' },
}

export const VERDICT_ORDER: VerdictCategory[] = ['product_bug', 'case_defect', 'script_defect', 'env_issue', 'test_data', 'deployment', 'permission', 'external_dependency', 'flaky', 'requirement_gap', 'unknown']

export const ARTIFACT_KIND: Record<ArtifactKind, string> = {
  input: '输入物料',
  clarification: '需求澄清',
  spec: 'Spec',
  design: '系分',
  contract: '契约',
  'test-plan': '测试计划',
  case: '用例',
  task: '开发任务',
  script: '脚本',
  'code-change': '代码改动',
  evidence: '证据',
  verdict: '判决',
  review: '评审',
  report: '报告',
  decision: '决策',
  knowledge: '知识回流',
  defect: '缺陷归因',
  other: '其他',
}

export const ARTIFACT_KIND_ORDER: ArtifactKind[] = [
  'input',
  'clarification',
  'spec',
  'design',
  'contract',
  'test-plan',
  'case',
  'task',
  'script',
  'code-change',
  'evidence',
  'verdict',
  'review',
  'report',
  'decision',
  'knowledge',
  'defect',
  'other',
]

export const CONTEXT_SOURCE: Record<ContextSource, { label: string; color: string }> = {
  system: { label: '系统提示', color: 'var(--c-7)' },
  role: { label: '角色', color: 'var(--c-6)' },
  skill: { label: '技能', color: 'var(--c-5)' },
  artifact: { label: '产物', color: 'var(--c-1)' },
  knowledge: { label: '知识', color: 'var(--c-2)' },
  lesson: { label: '经验', color: 'var(--c-3)' },
  prompt: { label: 'Prompt', color: 'var(--c-3)' },
  history: { label: '历史', color: 'var(--c-4)' },
  tool_result: { label: '工具结果', color: 'var(--c-8)' },
}

export const toneVar = (tone: Tone) => `var(--st-${tone})`
export const toneSoftVar = (tone: Tone) => (tone === 'pending' ? 'var(--surface-hover)' : `var(--st-${tone}-soft)`)
