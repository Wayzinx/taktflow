import type { StewardToolCall } from '@taktflow/core'

/** 动作行（docs/design/25 §1）：工具调用一律写成"动词 + 对象 + 结果"，不同 harness 的工具名归到同一张动词表。 */
export type ActionKind = 'read' | 'search' | 'edit' | 'command' | 'web' | 'knowledge' | 'delegate' | 'other'

export const ACTION_VERB: Record<ActionKind, string> = {
  read: '读取',
  search: '搜索',
  edit: '修改',
  command: '运行',
  web: '访问',
  knowledge: '检索',
  delegate: '派给',
  other: '调用',
}

export interface Action {
  kind: ActionKind
  verb: string
  /** 显示用的短对象（路径只留末两段）。 */
  target: string
  /** 完整对象，悬停提示用。 */
  full: string
  /** 结果词：通过 / 失败 / 7 条 / +12 −3。 */
  result?: string
  ok?: boolean
  add?: number
  del?: number
}

// 顺序有意义：先认 web / 知识库，再认读写（web_fetch 不是"读取"，kb_query 不是"搜索"）
const RULES: Array<[ActionKind, RegExp]> = [
  ['web', /web|fetch|http|browse|url/],
  ['knowledge', /^kb|knowledge/],
  ['delegate', /^(task|agent|subagent|dispatch)/],
  ['edit', /write|edit|patch|file_change|replace|create_file|str_replace|insert/],
  ['command', /bash|shell|command|exec|run|terminal/],
  ['search', /grep|glob|search|find|list|^ls$|codebase/],
  ['read', /read|cat|view|open|^get_file/],
]

export function actionKind(tool: string): ActionKind {
  const t = tool.toLowerCase()
  return RULES.find(([, re]) => re.test(t))?.[0] ?? 'other'
}

const TARGET_KEYS = ['file_path', 'path', 'pattern', 'command', 'cmd', 'query', 'q', 'url', 'text', 'description', 'prompt']

/** 输入可能是 JSON（native / MCP）或纯文本（codex 命令）；取最能说明"对谁做"的那个字段。 */
function targetOf(input: string): string {
  const raw = input.trim()
  if (raw.startsWith('{')) {
    try {
      const v = JSON.parse(raw) as Record<string, unknown>
      for (const k of TARGET_KEYS) {
        const x = v[k]
        if (typeof x === 'string' && x.trim()) return x.trim()
        if (Array.isArray(x) && x.every((y) => typeof y === 'string')) return x.join(' ')
      }
    } catch {
      // 不是合法 JSON：按文本处理
    }
  }
  // codex 的 file_change 输入是 [{path, kind}]
  if (raw.startsWith('[')) {
    try {
      const v = JSON.parse(raw) as Array<{ path?: string }>
      const paths = v.map((x) => x.path).filter((p): p is string => typeof p === 'string')
      if (paths.length) return paths.length > 1 ? `${paths.length} 个文件` : paths[0]!
    } catch {
      // 同上
    }
  }
  const patched = /\*\*\* (?:Update|Add|Delete) File: (.+)/.exec(raw)
  if (patched) return patched[1]!.trim()
  return raw.split('\n')[0]!.trim()
}

/** 路径只显示末两段；命令与查询截到 48 字。 */
export function shortTarget(s: string): string {
  if (/^[\w./@-]+$/.test(s) && s.includes('/')) {
    const parts = s.split('/').filter(Boolean)
    return parts.length > 2 ? `…/${parts.slice(-2).join('/')}` : s
  }
  return s.length > 48 ? `${s.slice(0, 47)}…` : s
}

/** 从补丁 / diff 里数增删行；数不出就不写。 */
export function diffStat(text: string | undefined): { add: number; del: number } | undefined {
  if (!text || !/^(@@|\*\*\* |[+-]{3} |diff --git)/m.test(text)) return undefined
  let add = 0
  let del = 0
  for (const line of text.split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---')) continue
    if (line.startsWith('+')) add++
    else if (line.startsWith('-')) del++
  }
  return add || del ? { add, del } : undefined
}

/** harness.tool_call → 动作。 */
export function toolAction(tool: string, input: string, output?: string, ok?: boolean): Action {
  const kind = actionKind(tool)
  const object = targetOf(input)
  // 认不出的工具（MCP 等）把工具名当对象的一部分："调用 github.create_issue …"
  const full = kind === 'other' ? [tool, object].filter(Boolean).join(' ') : object || tool
  const a: Action = { kind, verb: ACTION_VERB[kind], target: shortTarget(full), full, ok }
  if (ok === false) a.result = '失败'
  else if (kind === 'command' && ok === true) a.result = '通过'
  else if (kind === 'edit') {
    const stat = diffStat(input) ?? diffStat(output)
    if (stat) Object.assign(a, stat)
  } else if (kind === 'search' && output) {
    const lines = output.split('\n').filter((l) => l.trim()).length
    if (lines > 0) a.result = `${lines} 处`
  }
  return a
}

/** 管家工具：动词 + 对象来自工具名与输入，结果词来自返回条数。 */
const STEWARD: Record<string, (input: Record<string, unknown>) => [string, string]> = {
  list_spaces: () => ['查看', '空间列表'],
  resolve_space: (i) => ['核对', `空间「${str(i.name)}」`],
  space_overview: () => ['查看', '空间总览'],
  resolve_requirement: (i) => ['核对', `需求「${str(i.name)}」`],
  list_requirements: (i) => ['查看', i.status ? `${str(i.status)} 的需求` : '需求列表'],
  requirement_status: (i) => ['查看', `${str(i.requirementId)} 的状态`],
  run_status: (i) => ['查看', `运行 ${str(i.runId)}`],
  list_attention: () => ['查看', '待办'],
  list_risks: () => ['查看', '风险'],
  get_metrics: (i) => ['查看', i.requirementId ? `${str(i.requirementId)} 的指标` : '指标'],
  workflow_get: (i) => ['读取', `workflow ${str(i.workflowId)}`],
  get_config: () => ['读取', '空间配置'],
  eval_scorecards: () => ['查看', '成绩单'],
  list_commands: () => ['查看', '可用命令'],
  read_file: (i) => ['读取', shortTarget(str(i.path))],
  knowledge_search: (i) => ['检索', `「${shortTarget(str(i.text))}」`],
  propose: (i) => ['起草', `提案「${shortTarget(str(i.title))}」`],
  ask_lead: (i) => ['转达', `${str(i.requirementId)} 的 Lead`],
  show: () => ['绘制', '可视化'],
}
const str = (v: unknown) => (typeof v === 'string' ? v : v === undefined ? '' : String(v))

const STEWARD_KIND: Record<string, ActionKind> = { 查看: 'read', 核对: 'search', 读取: 'read', 检索: 'knowledge', 起草: 'edit', 转达: 'delegate' }

export function stewardAction(t: StewardToolCall): Action {
  const [verb, target] = STEWARD[t.tool]?.(t.input ?? {}) ?? ['调用', t.tool]
  const a: Action = { kind: STEWARD_KIND[verb] ?? 'other', verb, target, full: `${verb} ${target}`, ok: t.ok }
  if (t.ok === false) a.result = '失败'
  else if (t.ok) {
    const out = t.output as { exact?: boolean; hits?: unknown[] } | unknown[] | string | undefined
    const counted = /返回 (\d+) 条/.exec(t.summary ?? '')?.[1]
    if (t.tool === 'show') {
      const n = /(\d+) 个块/.exec(t.summary ?? '')?.[1]
      if (n) a.result = `${n} 个块`
    } else if ((t.tool === 'resolve_space' || t.tool === 'resolve_requirement') && out && typeof out === 'object' && !Array.isArray(out)) a.result = out.exact ? '找到' : '没找到'
    else if (t.tool === 'knowledge_search' && out && typeof out === 'object' && !Array.isArray(out) && Array.isArray(out.hits)) a.result = `${out.hits.length} 条命中`
    else if (Array.isArray(out)) a.result = `${out.length} 条`
    // 返回超过 20KB 时 output 是截断的字符串：条数只能从 summary 里取；单个对象（"返回 1 条"）不写
    else if (counted && counted !== '1') a.result = `${counted} 条`
  }
  return a
}

export interface ActionGroup<T> {
  action: Action
  items: T[]
}

/**
 * 连续、同动词、同节点的成功调用合并成一行 ×N（对象改成"N 个文件"之类）；失败的不合并，要单独看见。
 * key 决定"同一处"（例如节点 id）；不传则只按动词合并。
 */
export function groupActions<T>(items: T[], actionOf: (x: T) => Action, key: (x: T) => string = () => ''): Array<ActionGroup<T>> {
  const out: Array<ActionGroup<T> & { k: string }> = []
  for (const x of items) {
    const a = actionOf(x)
    const k = `${key(x)}|${a.verb}`
    const last = out[out.length - 1]
    // 同一个对象连续做多次（反复读同一文件）也合并，只记次数
    if (last && last.k === k && a.ok !== false && last.action.ok !== false) last.items.push(x)
    else out.push({ action: a, items: [x], k })
  }
  return out.map(({ action, items: xs }) => (xs.length > 1 ? { action: merged(action, xs.map(actionOf)), items: xs } : { action, items: xs }))
}

const NOUN: Partial<Record<ActionKind, string>> = { read: '个文件', edit: '个文件', command: '条命令', search: '次', web: '个地址', knowledge: '次' }

function merged(first: Action, all: Action[]): Action {
  const targets = [...new Set(all.map((a) => a.target))]
  const add = all.reduce((n, a) => n + (a.add ?? 0), 0)
  const del = all.reduce((n, a) => n + (a.del ?? 0), 0)
  const target = targets.length === 1 ? targets[0]! : NOUN[first.kind] ? `${targets.length} ${NOUN[first.kind]}` : `${targets[0]} 等 ${targets.length} 项`
  return {
    ...first,
    target,
    full: targets.join('\n'),
    result: first.kind === 'command' && all.every((a) => a.ok === true) ? '全部通过' : first.result && targets.length === 1 ? first.result : undefined,
    ...(add || del ? { add, del } : { add: undefined, del: undefined }),
  }
}
