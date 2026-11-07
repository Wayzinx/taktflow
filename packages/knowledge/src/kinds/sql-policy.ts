// 只接受能可靠识别的 SQL 词法；复杂方言语法应通过受限只读账号另行接入。
export function sqlTokens(input: string): string[] {
  const tokens: string[] = []
  for (let offset = 0; offset < input.length;) {
    const rest = input.slice(offset)
    const ignored = /^(?:\s+|--[^\r\n]*|#[^\r\n]*|\/\*[\s\S]*?\*\/)/.exec(rest)
    if (ignored) {
      offset += ignored[0].length
      continue
    }
    const token =
      /^(?:'(?:''|[^'\\])*'|"(?:""|[^"\\])*"|`(?:``|[^`\\])*`|\[(?:[^\]])*\]|[A-Za-z_][A-Za-z_0-9$]*|\d+(?:\.\d+)?|[(),.*=<>+/%!|&:;?-])/.exec(
        rest,
      )
    if (!token) throw new Error('SQL 语法无法安全识别，请使用标准只读查询')
    tokens.push(token[0])
    offset += token[0].length
  }
  return tokens
}
export function identifier(token: string): string {
  return token.replace(/^["`\[]|["`\]]$/g, '').toLowerCase()
}
export function checkTables(tokens: string[], config: Record<string, unknown>): void {
  const tables = config.tables as string[] | undefined
  const schemas = config.schemas as string[] | undefined
  if (!tables && !schemas) return
  if (tokens[0]?.toLowerCase() !== 'select')
    throw new Error('配置表白名单时只支持 SELECT，请使用明确的表名')
  const allowedTables = tables?.map((table) => table.toLowerCase())
  const allowedSchemas = schemas?.map((schema) => schema.toLowerCase())
  const fromDepths = new Set<number>()
  let depth = 0
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]!.toLowerCase()
    if (token === '(') {
      depth++
      continue
    }
    if (token === ')') {
      fromDepths.delete(depth)
      depth--
      continue
    }
    if (
      ['where', 'group', 'order', 'having', 'limit', 'union', 'except', 'intersect'].includes(token)
    )
      fromDepths.delete(depth)
    if (token !== 'from' && token !== 'join' && !(token === ',' && fromDepths.has(depth))) continue
    fromDepths.add(depth)
    if (tokens[index + 1] === '(') continue
    const first = tokens[++index]
    if (!first || !/^[A-Za-z_"`\[]/.test(first)) throw new Error('无法识别表名，请使用明确的表名')
    let table = identifier(first)
    let schema: string | undefined
    if (tokens[index + 1] === '.') {
      schema = table
      table = identifier(tokens[index + 2] ?? '')
      index += 2
    }
    if (tokens[index + 1] === '(' || tokens[index + 1] === '.')
      throw new Error('表函数或跨库引用不在白名单内')
    if (allowedSchemas && (!schema || !allowedSchemas.includes(schema)))
      throw new Error('查询 schema 不在白名单内，请使用完整表名')
    if (
      allowedTables &&
      !allowedTables.includes(schema ? `${schema}.${table}` : table) &&
      !(allowedTables.includes(table) && (!schema || !!allowedSchemas?.includes(schema)))
    ) {
      throw new Error('查询表不在白名单内，请选择已授权的表')
    }
  }
}
