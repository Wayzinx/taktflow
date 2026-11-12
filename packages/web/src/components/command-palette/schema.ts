import type { CommandInfo } from '@taktflow/core'
import type { PaletteContext } from './items'

/** ⌘K 能生成表单的 JSON Schema 子集：object 下一层的 string / enum / number / integer / boolean。 */
export interface FieldSpec {
  key: string
  title: string
  type: 'string' | 'enum' | 'number' | 'boolean' | 'json'
  options?: string[]
  required: boolean
  description?: string
  defaultValue?: unknown
  /** 来自当前页面的上下文 */
  fromContext?: boolean
}

export type FieldValue = string | boolean

interface PropSchema {
  type?: string | string[]
  title?: string
  description?: string
  enum?: unknown[]
  default?: unknown
}

/** 命令参数的中文名：真实注册表的 schema 不带 title，表单不该直接显示 requirementId / draft 这类参数名（TF-042）。 */
const FIELD_LABEL: Record<string, string> = {
  requirementId: '需求',
  runId: '运行',
  nodeId: '节点',
  nodeIds: '节点',
  workflowId: '流水线',
  requestId: '待办',
  defectId: '缺陷',
  caseId: '用例',
  caseIds: '用例',
  checkpointId: '检查点',
  suggestionId: '合并建议',
  title: '标题',
  description: '描述',
  owner: '负责人',
  members: '成员',
  dueAt: '截止时间',
  start: '创建后立即启动',
  repos: '仓库',
  budget: '预算',
  attachments: '附件',
  links: '链接',
  draft: '草稿（还没创建的需求）',
  hint: '补充说明',
  override: '手动指定档位',
  tier: '档位',
  decision: '决定',
  answer: '回答',
  status: '状态',
  state: '处置',
  groupKey: '问题分组',
  task: '任务',
  text: '问题',
  intent: '意图',
  bases: '知识库',
  version: '版本',
  severity: '严重程度',
  verdict: '判决',
  note: '备注',
  reason: '原因',
  pending: '只看未处理',
  target: '评测对象',
  variants: '对比方案',
  repeats: '重复次数',
  judge: '判分设置',
  includeDefects: '包含逃逸缺陷',
  baseRevision: '基线版本',
  baseRev: '基线版本',
  path: '文件路径',
  content: '内容',
  name: '名称',
  kind: '类型',
  by: '统计维度',
}

export function fieldsOf(cmd: CommandInfo): FieldSpec[] {
  const schema = cmd.input as { properties?: Record<string, PropSchema>; required?: string[] }
  const required = new Set(schema.required ?? [])
  return Object.entries(schema.properties ?? {}).map(([key, p]) => {
    const t = Array.isArray(p.type) ? p.type.find((x) => x !== 'null') : p.type
    const type: FieldSpec['type'] = p.enum ? 'enum' : t === 'string' ? 'string' : t === 'number' || t === 'integer' ? 'number' : t === 'boolean' ? 'boolean' : 'json'
    const description = p.description ?? (type === 'json' ? 'JSON 格式' : undefined)
    return { key, title: p.title ?? FIELD_LABEL[key] ?? key, type, options: p.enum?.map(String), required: required.has(key), description, defaultValue: p.default }
  })
}

const CONTEXT_KEYS: Record<string, keyof PaletteContext> = { requirementId: 'requirementId', runId: 'runId', nodeId: 'nodeId' }

/** 初值：调用方给的 > 页面上下文 > schema 默认值。 */
export function initialValues(fields: FieldSpec[], ctx: PaletteContext, given: Record<string, unknown> = {}): { values: Record<string, FieldValue>; fromContext: Set<string> } {
  const values: Record<string, FieldValue> = {}
  const fromContext = new Set<string>()
  for (const f of fields) {
    const g = given[f.key]
    const c = CONTEXT_KEYS[f.key] ? ctx[CONTEXT_KEYS[f.key]!] : undefined
    if (g !== undefined) values[f.key] = f.type === 'boolean' ? !!g : f.type === 'json' ? JSON.stringify(g) : String(g)
    else if (c) {
      values[f.key] = c
      fromContext.add(f.key)
    } else if (f.defaultValue !== undefined) values[f.key] = f.type === 'boolean' ? !!f.defaultValue : f.type === 'json' ? JSON.stringify(f.defaultValue) : String(f.defaultValue)
    else values[f.key] = f.type === 'boolean' ? false : ''
  }
  return { values, fromContext }
}

/** 表单值 → 命令输入；空字符串视为未填。返回缺少的必填项与无法解析的 JSON 字段。 */
export function toInput(fields: FieldSpec[], values: Record<string, FieldValue>): { input: Record<string, unknown>; missing: string[]; invalid: string[] } {
  const input: Record<string, unknown> = {}
  const missing: string[] = []
  const invalid: string[] = []
  for (const f of fields) {
    const v = values[f.key]
    if (f.type === 'boolean') {
      input[f.key] = !!v
      continue
    }
    const s = typeof v === 'string' ? v.trim() : ''
    if (!s) {
      if (f.required) missing.push(f.title)
      continue
    }
    if (f.type === 'number') {
      const n = Number(s)
      if (Number.isFinite(n)) input[f.key] = n
      else invalid.push(f.title)
    } else if (f.type === 'json') {
      try {
        input[f.key] = JSON.parse(s)
      } catch {
        invalid.push(f.title)
      }
    } else input[f.key] = s
  }
  return { input, missing, invalid }
}

export const SCOPE_KEY = { requirement: 'requirementId', run: 'runId', node: 'nodeId' } as const
type Scope = keyof typeof SCOPE_KEY

/**
 * 命令适用的上下文：优先用 scope；真实注册表不带 scope，就从 input.required 里的 requirementId / runId / nodeId 推断。
 */
export function commandScope(cmd: CommandInfo): Scope[] {
  if (cmd.scope?.length) return cmd.scope
  const required = (cmd.input as { required?: string[] }).required ?? []
  return (Object.keys(SCOPE_KEY) as Scope[]).filter((s) => required.includes(SCOPE_KEY[s]))
}
