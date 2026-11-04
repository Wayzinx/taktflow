export function extractJsonBlock(text: string): unknown {
  // 先确定最后一个开头；即使它未闭合或 JSON 无效，也不能使用旧块。
  const openings = [...text.matchAll(/^[\t ]*```json[^\S\r\n]*\r?\n/gim)]
  const last = openings.at(-1)
  if (!last) return undefined
  const tail = text.slice(last.index! + last[0].length)
  const end = /^[\t ]*```[^\S\r\n]*(?:\r?\n|$)/m.exec(tail)
  if (!end) return undefined
  try {
    return JSON.parse(tail.slice(0, end.index)) as unknown
  } catch {
    return undefined
  }
}

