import ts from 'typescript'
import { parseWorkflowSource } from './parse.js'

export function convertWorkflowSource(source: string): { ok: boolean; source?: string; reason?: string } {
  const file = ts.createSourceFile('workflow.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const exported = file.statements.find((node): node is ts.ExportAssignment => ts.isExportAssignment(node) && !node.isExportEquals)
  if (!exported) return { ok: false, reason: '缺少默认导出，请让管家生成文件提案' }
  if (ts.isCallExpression(exported.expression) && exported.expression.expression.getText(file) === 'defineWorkflow') return { ok: false, reason: '已是可编辑写法' }
  let object: ts.ObjectLiteralExpression | undefined
  let declaration: ts.VariableStatement | undefined
  if (ts.isObjectLiteralExpression(exported.expression)) object = exported.expression
  else if (ts.isIdentifier(exported.expression)) {
    const name = exported.expression.text
    for (const node of file.statements) if (ts.isVariableStatement(node) && node.declarationList.flags & ts.NodeFlags.Const && node.declarationList.declarations.length === 1) {
      const decl = node.declarationList.declarations[0]!
      if (ts.isIdentifier(decl.name) && decl.name.text === name && decl.initializer && ts.isObjectLiteralExpression(decl.initializer)) { object = decl.initializer; declaration = node }
    }
    // 有其它引用、修改或导出时移动对象会改变运行语义，交给人工提案。
    let references = 0
    const visit = (node: ts.Node) => { if (ts.isIdentifier(node) && node.text === name) references++; ts.forEachChild(node, visit) }
    visit(file)
    if (declaration && (file.statements.indexOf(exported) !== file.statements.indexOf(declaration) + 1 || declaration.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword))) return { ok: false, reason: '导出变量存在其它执行顺序或导出依赖，请让管家生成文件提案' }
    if (references !== 2) return { ok: false, reason: '默认导出变量还被其它代码引用，请让管家生成文件提案' }
  }
  if (!object) return { ok: false, reason: '只支持对象字面量或 const 对象的默认导出，请让管家生成文件提案' }
  let bindingConflict = false
  for (const statement of file.statements) {
    if (ts.isVariableStatement(statement) && statement.declarationList.declarations.some((decl) => decl.name.getText(file) === 'defineWorkflow')) bindingConflict = true
    if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) && statement.name?.text === 'defineWorkflow') bindingConflict = true
    if (ts.isImportDeclaration(statement)) {
      const clause = statement.importClause
      if (clause?.name?.text === 'defineWorkflow') bindingConflict = true
      const bindings = clause?.namedBindings
      if (bindings && ts.isNamespaceImport(bindings) && bindings.name.text === 'defineWorkflow') bindingConflict = true
      if (bindings && ts.isNamedImports(bindings)) for (const item of bindings.elements) {
        if (item.name.text === 'defineWorkflow' && (clause?.isTypeOnly || item.isTypeOnly || !ts.isStringLiteral(statement.moduleSpecifier) || statement.moduleSpecifier.text !== '@taktflow/core' || (item.propertyName?.text ?? item.name.text) !== 'defineWorkflow')) bindingConflict = true
      }
    }
  }
  if (bindingConflict) return { ok: false, reason: 'defineWorkflow 名称冲突，请让管家生成文件提案' }
  const edits: Array<{ start: number; end: number; text: string }> = [
    { start: exported.expression.getStart(file), end: exported.expression.end, text: `defineWorkflow(${object.getText(file)})` },
  ]
  if (declaration) {
    const comments = source.slice(declaration.getStart(file), object.getStart(file)).match(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g)?.join('\n') ?? ''
    edits.push({ start: declaration.getStart(file), end: declaration.end, text: comments })
  }
  let imported = false
  for (const statement of file.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier) || statement.moduleSpecifier.text !== '@taktflow/core' || statement.importClause?.isTypeOnly) continue
    const bindings = statement.importClause?.namedBindings
    if (bindings && ts.isNamedImports(bindings)) {
      const existing = bindings.elements.find((item) => item.name.text === 'defineWorkflow' && !item.isTypeOnly)
      if (existing && (existing.propertyName?.text ?? existing.name.text) !== 'defineWorkflow') return { ok: false, reason: 'defineWorkflow 名称冲突，请让管家生成文件提案' }
      if (!existing) edits.push({ start: bindings.getStart(file) + 1, end: bindings.getStart(file) + 1, text: ' defineWorkflow,' })
      imported = true; break
    }
  }
  if (!imported) edits.push({ start: 0, end: 0, text: "import { defineWorkflow } from '@taktflow/core'\n" })
  let converted = source
  for (const edit of edits.sort((a, b) => b.start - a.start)) converted = converted.slice(0, edit.start) + edit.text + converted.slice(edit.end)
  const parsed = parseWorkflowSource(converted)
  const errors = parsed.diagnostics.filter((item) => item.severity === 'error')
  if (!parsed.model.editable || errors.length) return { ok: false, reason: errors.map((item) => item.message).join('；') || '转换后仍不可编辑' }
  return { ok: true, source: converted }
}
