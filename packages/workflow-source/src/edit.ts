import ts from 'typescript'
import type { EditableNode, EditableValue, WorkflowDiagnostic, WorkflowEdit } from '@taktflow/core'
import { parseWorkflowSource } from './parse.js'
import type { NodeSpan, ObjectSpan, ParsedWorkflow, SourceSpan } from './parse.js'
import { serializeKey, serializeLiteral, serializeValue } from './serialize.js'

export class WorkflowSourceError extends Error {
  constructor(public readonly diagnostics: WorkflowDiagnostic[]) {
    super(diagnostics.map((d) => `${d.line ? `第 ${d.line} 行：` : ''}${d.message}`).join('\n'))
    this.name = 'WorkflowSourceError'
  }
}

const replace = (source: string, span: SourceSpan, text: string) => source.slice(0, span.start) + text + source.slice(span.end)
const newline = (source: string) => source.includes('\r\n') ? '\r\n' : '\n'
const lineStart = (source: string, at: number) => source.lastIndexOf('\n', at - 1) + 1
const indentAt = (source: string, at: number) => source.slice(lineStart(source, at), at).match(/^[\t ]*/)?.[0] ?? ''

function commaAfter(source: string, at: number): SourceSpan | undefined {
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, true, ts.LanguageVariant.Standard, source)
  scanner.setTextPos(at)
  return scanner.scan() === ts.SyntaxKind.CommaToken ? { start: scanner.getTokenPos(), end: scanner.getTextPos() } : undefined
}

function removeElement(source: string, node: ts.Node, siblings: ts.NodeArray<ts.Node>): string {
  let start = node.getStart()
  let end = node.end
  const comma = commaAfter(source, end)
  if (comma) end = comma.end
  const line = lineStart(source, start)
  const tail = source.slice(end).match(/^[\t ]*\r?\n/)
  if (/^[\t ]*$/.test(source.slice(line, start)) && tail) { start = line; end += tail[0].length }
  let result = replace(source, { start, end }, '')
  if (!comma) {
    const previous = siblings[siblings.indexOf(node) - 1]
    const preceding = previous && commaAfter(source, previous.end)
    if (preceding) result = replace(result, preceding, '')
  }
  return result
}

function setProperty(source: string, object: ObjectSpan, key: string, value: EditableValue | null): string {
  const property = object.properties.get(key)
  if (property) {
    if (value !== null) {
      const ast = object.ast.properties.find((p) => p.getStart() === property.start)!
      return ts.isShorthandPropertyAssignment(ast)
        ? replace(source, property, `${serializeKey(key)}: ${serializeValue(value)}`)
        : replace(source, property.value, serializeValue(value))
    }
    return removeElement(source, object.ast.properties.find((p) => p.getStart() === property.start)!, object.ast.properties)
  }
  if (value === null) return source
  const text = `${serializeKey(key)}: ${serializeValue(value)}`
  const last = object.ast.properties.at(-1)
  const close = object.end - 1
  const multiline = source.slice(object.start, close).includes('\n')
  if (multiline && /^[\t ]*$/.test(source.slice(lineStart(source, close), close))) {
    const indent = object.ast.properties[0] ? indentAt(source, object.ast.properties[0].getStart()) : indentAt(source, close) + '  '
    let result = replace(source, { start: lineStart(source, close), end: lineStart(source, close) }, `${indent}${text},${newline(source)}`)
    if (last && !commaAfter(source, last.end)) result = replace(result, { start: last.end, end: last.end }, ',')
    return result
  }
  if (!last) return replace(source, { start: close, end: close }, ` ${text}${source[close - 1] === ' ' ? '' : ' '}`)
  const comma = commaAfter(source, last.end)
  const at = comma?.end ?? last.end
  return replace(source, { start: at, end: at }, `${comma ? '' : ','} ${text}${comma ? ',' : ''}`)
}

function requireNode(parsed: ParsedWorkflow, id: string): NodeSpan {
  const node = parsed.spans.byId.get(id)
  if (!node) throw new Error(`节点不存在：${id}`)
  return node
}

function insertNode(source: string, parsed: ParsedWorkflow, text: string, after?: string | null, parent?: string | null): string {
  const array = parent ? parsed.spans.bodies.get(parent) : parsed.spans.nodes
  if (!array) throw new Error(`找不到节点数组：${parent ?? 'nodes'}`)
  const anchor = after === undefined ? array.elements.at(-1) : after === null ? undefined : requireNode(parsed, after).ast
  if (anchor && !array.elements.includes(anchor)) throw new Error(`after 节点不在目标数组：${after}`)
  const first = array.elements[0]
  const indent = first ? indentAt(source, first.getStart()) || indentAt(source, array.getStart()) + '  ' : indentAt(source, array.getStart()) + '  '
  const eol = newline(source)
  let at: number
  let prefix = ''
  let suffix = ''
  let addComma = false
  if (anchor) {
    const comma = commaAfter(source, anchor.end)
    addComma = !comma
    at = comma?.end ?? anchor.end
    const tail = source.slice(at, array.end - 1)
    const lineTail = tail.match(/^[\t ]*(?:\/\/[^\r\n]*)?\r?\n/)
    if (lineTail) at += lineTail[0].length
    else { prefix = eol; suffix = eol + indentAt(source, array.getStart()) }
  } else {
    at = array.getStart() + 1
    const head = source.slice(at, array.end - 1).match(/^[\t ]*\r?\n/)
    if (head) at += head[0].length
    else { prefix = eol; suffix = eol + indentAt(source, array.getStart()) }
  }
  let result = replace(source, { start: at, end: at }, `${prefix}${indent}${text},${suffix || eol}`)
  if (addComma && anchor) result = replace(result, { start: anchor.end, end: anchor.end }, ',')
  return result
}

function flatten(nodes: EditableNode[]): EditableNode[] {
  return nodes.flatMap((node) => [node, ...flatten(node.body ?? [])])
}

export function applyEdits(source: string, edits: WorkflowEdit[]): { source: string; summary: string; diagnostics: WorkflowDiagnostic[] } {
  const summaries: string[] = []
  const diagnostics: WorkflowDiagnostic[] = []
  const parse = () => {
    const parsed = parseWorkflowSource(source)
    if (!parsed.model.editable) throw new WorkflowSourceError(parsed.diagnostics)
    return parsed
  }
  parse()
  for (const edit of edits) {
    const parsed = parse()
    switch (edit.op) {
      case 'setProp':
      case 'setNeeds': {
        const key = edit.op === 'setNeeds' ? 'needs' : edit.key
        if (key === 'body' && requireNode(parsed, edit.id).ast.expression.getText() === 'loop') {
          throw new Error('loop.body 请使用节点操作编辑')
        }
        const value = edit.op === 'setNeeds' ? (edit.needs.length ? { kind: 'literal' as const, value: edit.needs } : null) : edit.value
        source = setProperty(source, requireNode(parsed, edit.id).object, key, value)
        summaries.push(`修改 ${edit.id}.${key}`)
        break
      }
      case 'setMeta':
        source = setProperty(source, parsed.spans.root!, edit.key, { kind: 'literal', value: edit.value })
        summaries.push(`修改 ${edit.key}`)
        break
      case 'setStages':
        source = replace(source, parsed.spans.stages!, serializeLiteral(edit.stages))
        summaries.push('修改阶段')
        break
      case 'addNode': {
        const entries = Object.entries(edit.props).map(([key, value]) => `${serializeKey(key)}: ${serializeValue(value)}`)
        if (edit.kind === 'loop' && !Object.hasOwn(edit.props, 'body')) entries.push('body: []')
        source = insertNode(source, parsed, `${edit.kind}({ ${entries.join(', ')} })`, edit.after, edit.parent)
        summaries.push(`新增节点 ${edit.props.id?.kind === 'literal' ? edit.props.id.value : ''}`)
        break
      }
      case 'removeNode': {
        const location = requireNode(parsed, edit.id)
        const node = flatten(parsed.model.nodes).find((item) => item.id === edit.id)!
        const deleted = new Set(flatten([node]).map((item) => item.id))
        source = removeElement(source, location.ast, location.array.elements)
        for (const other of flatten(parse().model.nodes)) {
          const needs = other.props.needs
          if (needs?.kind === 'code') {
            const current = parse()
            const at = current.spans.file.getLineAndCharacterOfPosition(requireNode(current, other.id).object.properties.get('needs')!.start)
            diagnostics.push({ severity: 'warning', message: `${other.id}.needs 是代码值，无法自动清理对已删除节点的引用`, nodeId: other.id, line: at.line + 1, column: at.character + 1 })
          } else if (needs?.kind === 'literal' && Array.isArray(needs.value)) {
            const remaining = needs.value.filter((id) => !deleted.has(id))
            if (remaining.length !== needs.value.length) source = setProperty(source, requireNode(parse(), other.id).object, 'needs', remaining.length ? { kind: 'literal', value: remaining } : null)
          }
        }
        summaries.push(`删除节点 ${edit.id}`)
        break
      }
      case 'moveNode': {
        const location = requireNode(parsed, edit.id)
        if (edit.after === edit.id) throw new Error('不能移动到自身之后')
        const destination = edit.parent ? requireNode(parsed, edit.parent) : undefined
        if (destination && destination.start >= location.start && destination.end <= location.end) throw new Error('不能把节点移动到自身或其子节点中')
        const text = source.slice(location.start, location.end)
        source = removeElement(source, location.ast, location.array.elements)
        source = insertNode(source, parse(), text, edit.after, edit.parent)
        summaries.push(`移动节点 ${edit.id}`)
        break
      }
    }
    parse()
  }
  return { source, summary: summaries.join('；'), diagnostics }
}
