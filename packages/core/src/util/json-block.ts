export function extractJsonBlock(text: string): unknown {
  return jsonBlockValues(text).values?.at(-1)
}

export function jsonBlockValues(text: string): { values?: unknown[]; problem?: string } {
  // 先确定最后一个开头；即使它未闭合或 JSON 无效，也不能使用旧块。
  const openings = [...text.matchAll(/^[\t ]*```json[^\S\r\n]*\r?\n/gim)]
  const last = openings.at(-1)
  if (!last) return { problem: '没有 json 代码块' }
  const tail = text.slice(last.index! + last[0].length)
  const end = /^[\t ]*```[^\S\r\n]*(?:\r?\n|$)/m.exec(tail)
  if (!end) return { problem: 'json 代码块未闭合' }
  const body = tail.slice(0, end.index)
  try {
    return { values: [JSON.parse(body) as unknown] }
  } catch (error) {
    // 模型常把要求的 schema 原样抄一遍再写结果，一个块里放了几个 JSON 值：取最后一个。
    const values = jsonValues(body)
    return values ? { values } : { problem: `json 代码块无法解析：${error instanceof Error ? error.message : String(error)}` }
  }
}

/** 把首尾相接的多个 JSON 值切开解析；任何一段无效就返回 undefined。 */
function jsonValues(source: string): unknown[] | undefined {
  const values: unknown[] = []
  let i = 0
  const skip = () => { while (i < source.length && /\s/.test(source[i]!)) i++ }
  for (skip(); i < source.length; skip()) {
    const start = i
    if (source[i] === '{' || source[i] === '[') {
      let depth = 0
      let inString = false
      for (; i < source.length; i++) {
        const ch = source[i]
        if (inString) {
          if (ch === '\\') i++
          else if (ch === '"') inString = false
        } else if (ch === '"') inString = true
        else if (ch === '{' || ch === '[') depth++
        else if ((ch === '}' || ch === ']') && --depth === 0) { i++; break }
      }
      if (depth !== 0) return undefined
    } else if (source[i] === '"') {
      i++
      while (i < source.length) {
        if (source[i] === '\\') i += 2
        else if (source[i++] === '"') break
      }
    } else {
      const token = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(source.slice(i))
      if (!token) return undefined
      i += token[0].length
    }
    try { values.push(JSON.parse(source.slice(start, i))) } catch { return undefined }
  }
  return values.length > 1 ? values : undefined
}
