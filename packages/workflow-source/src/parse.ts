import ts from 'typescript'
import type { EditableNode, EditableValue, EditableWorkflow, NodeKind, WorkflowDiagnostic } from '@taktflow/core'

export interface SourceSpan { start: number; end: number }
export interface PropertySpan extends SourceSpan { value: SourceSpan }
export interface ObjectSpan extends SourceSpan { properties: Map<string, PropertySpan>; ast: ts.ObjectLiteralExpression }
export interface NodeSpan extends SourceSpan { object: ObjectSpan; array: ts.ArrayLiteralExpression; ast: ts.CallExpression; parent?: string }
export interface WorkflowSpans {
  file: ts.SourceFile
  root?: ObjectSpan
  nodes?: ts.ArrayLiteralExpression
  stages?: SourceSpan
  byId: Map<string, NodeSpan>
  bodies: Map<string, ts.ArrayLiteralExpression>
}
export interface ParsedWorkflow { model: EditableWorkflow; diagnostics: WorkflowDiagnostic[]; spans: WorkflowSpans }

const kinds = new Set<string>(['agent', 'script', 'gate', 'human', 'judge', 'loop', 'planner', 'review', 'subflow'])
const literal = (value: unknown): EditableValue => ({ kind: 'literal', value })
const keyOf = (name: ts.PropertyName): string | undefined =>
  ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name) ? name.text : undefined

function literalValue(node: ts.Expression): EditableValue {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return literal(node.text)
  if (ts.isNumericLiteral(node)) return literal(Number(node.text))
  if (node.kind === ts.SyntaxKind.TrueKeyword) return literal(true)
  if (node.kind === ts.SyntaxKind.FalseKeyword) return literal(false)
  if (node.kind === ts.SyntaxKind.NullKeyword) return literal(null)
  if (ts.isPrefixUnaryExpression(node) && ts.isNumericLiteral(node.operand)
    && (node.operator === ts.SyntaxKind.MinusToken || node.operator === ts.SyntaxKind.PlusToken)) {
    return literal(Number(node.operand.text) * (node.operator === ts.SyntaxKind.MinusToken ? -1 : 1))
  }
  if (ts.isArrayLiteralExpression(node)) {
    const values = node.elements.map(literalValue)
    if (values.every((value) => value.kind === 'literal')) return literal(values.map((value) => value.value))
  }
  if (ts.isObjectLiteralExpression(node)) {
    const entries: Array<[string, unknown]> = []
    for (const prop of node.properties) {
      if (!ts.isPropertyAssignment(prop)) return { kind: 'code', code: node.getText() }
      const key = keyOf(prop.name)
      const value = literalValue(prop.initializer)
      if (key === undefined || value.kind === 'code' || key === '__proto__') return { kind: 'code', code: node.getText() }
      entries.push([key, value.value])
    }
    return literal(Object.fromEntries(entries))
  }
  return { kind: 'code', code: node.getText() }
}

export function parseWorkflowSource(source: string, fileName = 'workflow.ts'): ParsedWorkflow {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const diagnostics: WorkflowDiagnostic[] = []
  const spans: WorkflowSpans = { file, byId: new Map(), bodies: new Map() }
  const model: EditableWorkflow = {
    meta: { id: '', title: literal(''), version: literal('') }, stages: literal([]), nodes: [], editable: true,
  }
  const span = (node: ts.Node): SourceSpan => ({ start: node.getStart(file), end: node.end })
  const report = (node: ts.Node, message: string, nodeId?: string) => {
    const position = file.getLineAndCharacterOfPosition(node.getStart(file))
    diagnostics.push({ severity: 'error', message, line: position.line + 1, column: position.character + 1, nodeId })
  }
  const syntax = (file as ts.SourceFile & { parseDiagnostics: readonly ts.Diagnostic[] }).parseDiagnostics
  for (const diagnostic of syntax) {
    const position = file.getLineAndCharacterOfPosition(diagnostic.start ?? 0)
    diagnostics.push({ severity: 'error', message: ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'), line: position.line + 1, column: position.character + 1 })
  }
  function object(node: ts.ObjectLiteralExpression, label: string): { props: Record<string, EditableValue>; location: ObjectSpan } {
    const props: Record<string, EditableValue> = Object.create(null)
    const properties = new Map<string, PropertySpan>()
    for (const property of node.properties) {
      if (ts.isSpreadAssignment(property)) { report(property, `${label}里使用了展开运算符`); continue }
      if (!ts.isPropertyAssignment(property) && !ts.isShorthandPropertyAssignment(property)) {
        report(property, `${label}使用了方法或访问器，请改用具名属性赋值`); continue
      }
      const key = keyOf(property.name)
      if (key === undefined) { report(property, `${label}使用了计算属性名`); continue }
      if (properties.has(key)) report(property, `${label}属性 ${key} 重复`)
      const value = ts.isPropertyAssignment(property) ? property.initializer : property.name
      props[key] = literalValue(value)
      properties.set(key, { ...span(property), value: span(value) })
    }
    return { props, location: { ...span(node), properties, ast: node } }
  }
  function nodes(array: ts.ArrayLiteralExpression, parent?: string): EditableNode[] {
    const result: EditableNode[] = []
    for (const [index, element] of array.elements.entries()) {
      if (!ts.isCallExpression(element) || !ts.isIdentifier(element.expression) || !kinds.has(element.expression.text)) {
        report(element, `第 ${index + 1} 个节点不是支持的构造函数调用`); continue
      }
      const argument = element.arguments[0]
      if (element.arguments.length !== 1 || !argument || !ts.isObjectLiteralExpression(argument)) {
        report(element, `第 ${index + 1} 个节点参数不是单个对象字面量`); continue
      }
      const { props, location } = object(argument, '节点参数')
      const id = props.id?.kind === 'literal' && typeof props.id.value === 'string' ? props.id.value : ''
      if (!id) report(argument, `第 ${index + 1} 个节点 id 必须是非空字符串字面量`)
      if (spans.byId.has(id)) report(argument, `节点 id ${id} 重复，无法唯一定位`, id)
      const node: EditableNode = { id, kind: element.expression.text as NodeKind, props }
      spans.byId.set(id, { ...span(element), object: location, array, ast: element, parent })
      if (node.kind === 'loop') {
        const body = argument.properties.find((p) => p.name && keyOf(p.name) === 'body')
        if (!body || !ts.isPropertyAssignment(body) || !ts.isArrayLiteralExpression(body.initializer)) {
          report(body ?? argument, 'loop 的 body 不是数组字面量', id)
        } else {
          spans.bodies.set(id, body.initializer)
          node.body = nodes(body.initializer, id)
        }
      }
      result.push(node)
    }
    return result
  }
  const exports = file.statements.filter((statement): statement is ts.ExportAssignment => ts.isExportAssignment(statement) && !statement.isExportEquals)
  const expression = exports[0]?.expression
  if (exports.length !== 1 || !expression || !ts.isCallExpression(expression)
    || !ts.isIdentifier(expression.expression) || expression.expression.text !== 'defineWorkflow'
    || expression.arguments.length !== 1 || !ts.isObjectLiteralExpression(expression.arguments[0]!)) {
    report(exports[0] ?? file, '默认导出必须是 defineWorkflow({...})，参数为单个对象字面量')
  } else {
    const root = expression.arguments[0] as ts.ObjectLiteralExpression
    const { props, location } = object(root, 'workflow 参数')
    spans.root = location
    model.meta = {
      id: props.id?.kind === 'literal' && typeof props.id.value === 'string' ? props.id.value : '',
      title: props.title ?? literal(''), version: props.version ?? literal(''),
      ...(props.description ? { description: props.description } : {}),
    }
    for (const key of ['stages', 'nodes']) {
      const property = root.properties.find((p) => p.name && keyOf(p.name) === key)
      if (!property || !ts.isPropertyAssignment(property) || !ts.isArrayLiteralExpression(property.initializer)) {
        report(property ?? root, `${key} 不是数组字面量`)
      } else if (key === 'nodes') {
        spans.nodes = property.initializer
        model.nodes = nodes(property.initializer)
      } else {
        spans.stages = span(property.initializer)
        model.stages = props.stages!
      }
    }
  }
  model.editable = !diagnostics.some((diagnostic) => diagnostic.severity === 'error')
  return { model, diagnostics, spans }
}

export function lintWorkflowSource(source: string): WorkflowDiagnostic[] {
  return parseWorkflowSource(source).diagnostics
}
