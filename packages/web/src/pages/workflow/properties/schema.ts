import type { NodeKind } from '@taktflow/core'
import type { Option } from './options'

export type FieldType =
  | 'string' | 'mono' | 'text' | 'script' | 'number' | 'bool' | 'enum'
  | 'role' | 'harness' | 'stage' | 'node' | 'needs'
  | 'strings' | 'roles' | 'paths' | 'outputs' | 'reviewers' | 'json'
  | 'author' | 'pass' | 'exhausted' | 'routes' | 'target'

export interface FieldSpec {
  key: string
  label: string
  type: FieldType
  options?: Option[]
  hint?: string
  /** 缺省时是否允许删除这个键（可选属性）。 */
  optional?: boolean
  min?: number
  max?: number
}

const o = (...vals: Array<[string, string]>): Option[] => vals.map(([value, label]) => ({ value, label }))

const HEAD: FieldSpec[] = [
  { key: 'title', label: '标题', type: 'string' },
  { key: 'stage', label: '阶段', type: 'stage', optional: true },
  { key: 'needs', label: '依赖', type: 'needs', optional: true, hint: '也可以在画布上拖线添加、选中连线删除' },
]
const IO: FieldSpec[] = [
  { key: 'inputs', label: '输入', type: 'paths', optional: true },
  { key: 'outputs', label: '产出', type: 'outputs', optional: true },
]
const TAIL: FieldSpec[] = [
  { key: 'when', label: '执行条件', type: 'json', optional: true, hint: '通常是代码值：返回 false 时节点记为 skipped' },
  { key: 'retry', label: '重试', type: 'json', optional: true },
  { key: 'timeoutMs', label: '超时（毫秒）', type: 'number', optional: true, min: 0 },
]

const BY_KIND: Record<NodeKind, FieldSpec[]> = {
  agent: [
    { key: 'role', label: '角色', type: 'role' },
    { key: 'prompt', label: 'Prompt', type: 'text' },
    { key: 'harness', label: 'Harness', type: 'harness', optional: true, hint: '留空用角色默认的 harness' },
    { key: 'repo', label: '代码仓库', type: 'mono', optional: true },
    ...IO,
    { key: 'writeScope', label: '写权限（glob）', type: 'strings', optional: true },
    { key: 'session', label: '会话', type: 'enum', optional: true, options: o(['fresh', '每次新会话'], ['resume', '续上次会话']) },
  ],
  script: [{ key: 'run', label: '命令', type: 'script', hint: 'shell 命令，在项目目录执行；也可以是代码值（TS 函数）' }, ...IO],
  human: [
    { key: 'form', label: '表单', type: 'enum', options: o(['approve', '审批'], ['answer', '回答'], ['choice', '选择']) },
    { key: 'ask', label: '问题 / 待审说明', type: 'text' },
    { key: 'choices', label: '选项', type: 'strings', optional: true },
  ],
  gate: [
    { key: 'checks', label: '检查项', type: 'json' },
    { key: 'onFail', label: '不通过时', type: 'enum', optional: true, options: o(['stop', '停下'], ['human', '交人裁决']) },
  ],
  judge: [
    { key: 'role', label: '角色', type: 'role' },
    { key: 'target', label: '被判决的执行节点', type: 'node' },
    { key: 'routes', label: '路由', type: 'routes', hint: '每类根因交给哪个节点修；路由目标需依赖本节点' },
    { key: 'harness', label: 'Harness', type: 'harness', optional: true },
  ],
  loop: [
    { key: 'maxIterations', label: '最多轮次', type: 'number', min: 1, max: 50 },
    { key: 'onExhausted', label: '用完仍未收敛', type: 'enum', optional: true, options: o(['human', '交人'], ['fail', '失败']) },
    { key: 'until', label: '收敛条件', type: 'json' },
  ],
  planner: [
    { key: 'role', label: '角色', type: 'role' },
    { key: 'prompt', label: 'Prompt', type: 'text' },
    { key: 'maxItems', label: '最多条目', type: 'number', min: 1, max: 100 },
    { key: 'allowedRoles', label: '允许的角色', type: 'roles', optional: true },
    { key: 'harness', label: 'Harness', type: 'harness', optional: true },
    ...IO,
    { key: 'expand', label: '展开模板', type: 'json' },
  ],
  review: [
    { key: 'target', label: '评审对象', type: 'target' },
    { key: 'author', label: '作者', type: 'author' },
    { key: 'reviewers', label: '评审者', type: 'reviewers' },
    { key: 'pass', label: '通过规则', type: 'pass', optional: true },
    { key: 'maxRounds', label: '最多轮次（含首轮）', type: 'number', min: 1, max: 10 },
    { key: 'onExhausted', label: '轮次用尽', type: 'exhausted' },
    { key: 'humanSignoff', label: '评审通过后交人确认', type: 'bool', optional: true },
    { key: 'rubric', label: '评分标准', type: 'text', optional: true },
  ],
  subflow: [
    { key: 'workflow', label: '子 workflow', type: 'json' },
    { key: 'args', label: '参数', type: 'json', optional: true },
  ],
}

export function fieldsOf(kind: NodeKind, inLoop: boolean): FieldSpec[] {
  const head = inLoop ? HEAD.filter((f) => f.key !== 'stage') : HEAD
  return [...head, ...BY_KIND[kind], ...TAIL]
}

/** 不在表单里单独列出的键。 */
export const HIDDEN_KEYS = new Set(['id'])
