/**
 * 演示数据源扮演 server 的 workflow-source：把 EditableWorkflow 打印成受限子集的 .workflow.ts 源码，
 * 并提供修订哈希、统一 diff、冲突合并文本、校验诊断和结构快照。真实 server 做的是 AST 上的最小文本替换，这里整文件重打印。
 */
import type { EditableNode, EditableValue, EditableWorkflow, SnapshotNode, WorkflowDiagnostic, WorkflowSnapshot } from '@taktflow/core'
import { allNodes, literalOf, needsOf } from './workflow-edit'

const IDENT = /^[A-Za-z_$][\w$]*$/

function printLiteral(v: unknown, indent: string): string {
  if (typeof v === 'string') return `'${v.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n')}'`
  if (v === null || typeof v !== 'object') return String(v)
  const inner = indent + '  '
  const parts = Array.isArray(v)
    ? v.map((x) => printLiteral(x, inner))
    : Object.entries(v as Record<string, unknown>).filter(([, x]) => x !== undefined).map(([k, x]) => `${IDENT.test(k) ? k : printLiteral(k, inner)}: ${printLiteral(x, inner)}`)
  const [open, close] = Array.isArray(v) ? ['[', ']'] : ['{ ', ' }']
  if (parts.length === 0) return Array.isArray(v) ? '[]' : '{}'
  const flat = open + parts.join(', ') + close
  if (flat.length <= 96 && !flat.includes('\n')) return flat
  return `${open.trim()}\n${parts.map((p) => inner + p).join(',\n')},\n${indent}${close.trim()}`
}

const printValue = (v: EditableValue, indent: string) => (v.kind === 'code' ? v.code : printLiteral(v.value, indent))

/** 打印一个节点；记录每个节点起始行号（1 起），用于诊断定位。 */
function printNode(n: EditableNode, indent: string, out: string[], lines: Record<string, number>) {
  lines[n.id] = out.length + 1
  const inner = indent + '  '
  const keys = ['id', ...Object.keys(n.props).filter((k) => k !== 'id')]
  // 空依赖不打印
  const empty = (k: string) => k === 'needs' && Array.isArray(literalOf(n.props[k])) && literalOf<unknown[]>(n.props[k])!.length === 0
  const props = keys.filter((k) => n.props[k] && !empty(k)).map((k) => `${k}: ${printValue(n.props[k]!, inner)}`)
  const flat = `${indent}${n.kind}({ ${props.join(', ')} }),`
  if (!n.body && flat.length <= 120 && !flat.includes('\n')) return void out.push(flat)
  out.push(`${indent}${n.kind}({`)
  for (const p of props) out.push(...`${inner}${p},`.split('\n'))
  if (n.body) {
    out.push(`${inner}body: [`)
    for (const c of n.body) printNode(c, inner + '  ', out, lines)
    out.push(`${inner}],`)
  }
  out.push(`${indent}}),`)
}

export function printWorkflow(model: EditableWorkflow, preamble = ''): { source: string; lines: Record<string, number> } {
  const kinds = [...new Set(allNodes(model.nodes).map((n) => n.kind))].sort()
  const out: string[] = []
  if (preamble) out.push(...preamble.trimEnd().split('\n'))
  if (!preamble.includes("from '@taktflow/core'")) out.unshift(`import { ${['defineWorkflow', ...kinds].join(', ')} } from '@taktflow/core'`)
  out.push('', 'export default defineWorkflow({')
  out.push(`  id: ${printLiteral(model.meta.id, '  ')},`)
  for (const k of ['title', 'description', 'version'] as const) if (model.meta[k]) out.push(`  ${k}: ${printValue(model.meta[k]!, '  ')},`)
  out.push(...`  stages: ${printValue(model.stages, '  ')},`.split('\n'))
  out.push('  nodes: [')
  const lines: Record<string, number> = {}
  for (const n of model.nodes) printNode(n, '    ', out, lines)
  out.push('  ],', '})', '')
  return { source: out.join('\n'), lines }
}

/** 演示用的修订号：64 位十六进制（真实 server 是源码 sha256）。 */
export function hashSource(source: string): string {
  let out = ''
  for (let seed = 0; out.length < 64; seed++) {
    let h = 0x811c9dc5 ^ seed
    for (let i = 0; i < source.length; i++) h = Math.imul(h ^ source.charCodeAt(i), 0x01000193)
    out += (h >>> 0).toString(16).padStart(8, '0')
  }
  return out.slice(0, 64)
}

/** 行级统一 diff（LCS），3 行上下文。 */
export function unifiedDiff(a: string, b: string, file = 'workflow.ts'): string {
  if (a === b) return ''
  const x = a.split('\n')
  const y = b.split('\n')
  const dp = Array.from({ length: x.length + 1 }, () => new Array<number>(y.length + 1).fill(0))
  for (let i = x.length - 1; i >= 0; i--) for (let j = y.length - 1; j >= 0; j--) dp[i]![j] = x[i] === y[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!)
  // ai / bi：该行在 a / b 中的行号（1 起）；新增行没有 ai，删除行没有 bi，取前一行的位置
  const ops: Array<{ t: ' ' | '-' | '+'; s: string; ai: number; bi: number }> = []
  let i = 0
  let j = 0
  while (i < x.length || j < y.length) {
    if (i < x.length && j < y.length && x[i] === y[j]) ops.push({ t: ' ', s: x[i]!, ai: ++i, bi: ++j })
    else if (j < y.length && (i >= x.length || dp[i]![j + 1]! > dp[i + 1]![j]!)) ops.push({ t: '+', s: y[j]!, ai: i, bi: ++j })
    else ops.push({ t: '-', s: x[i]!, ai: ++i, bi: j })
  }
  const C = 3
  const changes = ops.flatMap((o, k) => (o.t === ' ' ? [] : [k]))
  const out = [`--- a/${file}`, `+++ b/${file}`]
  for (let c = 0; c < changes.length; ) {
    let last = changes[c]!
    let d = c + 1
    while (d < changes.length && changes[d]! - last <= 2 * C) last = changes[d++]!
    const hunk = ops.slice(Math.max(0, changes[c]! - C), Math.min(ops.length, last + C + 1))
    const first = hunk[0]!
    const aStart = first.t === '+' ? first.ai + 1 : first.ai
    const bStart = first.t === '-' ? first.bi + 1 : first.bi
    out.push(`@@ -${aStart},${hunk.filter((o) => o.t !== '+').length} +${bStart},${hunk.filter((o) => o.t !== '-').length} @@`)
    for (const o of hunk) out.push(o.t + o.s)
    c = d
  }
  return out.join('\n') + '\n'
}

/** 带冲突标记的合并结果：公共前后缀保留，中间整段标为冲突（演示用的粗粒度合并）。 */
export function conflictText(ours: string, theirs: string): string {
  const a = ours.split('\n')
  const b = theirs.split('\n')
  let p = 0
  while (p < a.length && p < b.length && a[p] === b[p]) p++
  let s = 0
  while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++
  return [...a.slice(0, p), '<<<<<<< 你的修改', ...a.slice(p, a.length - s), '=======', ...b.slice(p, b.length - s), '>>>>>>> 最新修订', ...a.slice(a.length - s)].join('\n')
}

/** DAG 校验：重复 id、依赖不存在、依赖成环、review 没有评审者。 */
export function validateWorkflow(model: EditableWorkflow, lines: Record<string, number>): WorkflowDiagnostic[] {
  const diags: WorkflowDiagnostic[] = []
  const nodes = allNodes(model.nodes)
  const ids = new Set<string>()
  const at = (nodeId: string) => ({ nodeId, line: lines[nodeId], column: 5 })
  for (const n of nodes) {
    if (ids.has(n.id)) diags.push({ severity: 'error', message: `节点 id 重复：${n.id}`, ...at(n.id) })
    ids.add(n.id)
  }
  for (const n of nodes) {
    for (const d of needsOf(n)) if (!ids.has(d)) diags.push({ severity: 'error', message: `${n.id} 依赖的节点 ${d} 不存在`, ...at(n.id) })
    if (n.kind === 'review' && (literalOf<unknown[]>(n.props.reviewers)?.length ?? 1) === 0) diags.push({ severity: 'error', message: `${n.id} 至少需要一个评审者`, ...at(n.id) })
    if (n.kind === 'agent' && !n.props.role) diags.push({ severity: 'warning', message: `${n.id} 没有指定角色，将使用默认 agent`, ...at(n.id) })
  }
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const state = new Map<string, 1 | 2>()
  const visit = (id: string, path: string[]): void => {
    if (state.get(id) === 2) return
    if (state.get(id) === 1) return void diags.push({ severity: 'error', message: `依赖成环：${[...path, id].join(' → ')}`, ...at(id) })
    state.set(id, 1)
    for (const d of needsOf(byId.get(id)!)) if (byId.has(d)) visit(d, [...path, id])
    state.set(id, 2)
  }
  for (const n of nodes) visit(n.id, [])
  return diags
}

function snapNode(n: EditableNode): SnapshotNode {
  const s = (k: string) => literalOf<string>(n.props[k])
  const base: SnapshotNode = { id: n.id, kind: n.kind, title: s('title') ?? n.id, stage: s('stage'), needs: needsOf(n), role: s('role'), prompt: s('prompt'), ask: s('ask'), repo: s('repo') }
  if (n.body) base.body = n.body.map(snapNode)
  if (n.kind === 'review') {
    const author = literalOf<{ role: string }>(n.props.author)
    base.review = {
      target: literalOf(n.props.target) ?? [],
      author: author?.role ?? '',
      reviewers: literalOf(n.props.reviewers) ?? [],
      pass: literalOf(n.props.pass) ?? 'all',
      maxRounds: literalOf(n.props.maxRounds) ?? 3,
      onExhausted: literalOf(n.props.onExhausted) ?? 'human',
      humanSignoff: literalOf(n.props.humanSignoff),
    }
  }
  return base
}

/** 校验通过时的结构快照（只取字面量属性；代码值在快照里缺省）。 */
export function snapshotOf(model: EditableWorkflow, diags: WorkflowDiagnostic[]): WorkflowSnapshot | undefined {
  if (diags.some((d) => d.severity === 'error')) return undefined
  return {
    id: model.meta.id,
    title: literalOf<string>(model.meta.title) ?? model.meta.id,
    description: literalOf<string>(model.meta.description),
    version: literalOf<string>(model.meta.version) ?? '0.0.0',
    stages: literalOf(model.stages) ?? [],
    nodes: model.nodes.map(snapNode),
  }
}
