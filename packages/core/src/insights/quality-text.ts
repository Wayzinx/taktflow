export interface RetrievalHit {
  startLine: number
  endLine: number
  text: string
  terms: string[]
  score: number
  truncated: boolean
}

export interface TextRetrieval {
  kind: 'text_retrieval'
  method: 'keyword_overlap'
  judgment: false
  hits: RetrievalHit[]
}

function keywords(text: string): string[] {
  const tokens = text.toLowerCase().match(/[a-z0-9][a-z0-9_-]+|\p{Script=Han}+/gu) ?? []
  const stop = new Set(['the', 'and', 'for', 'with', 'this', 'that', 'from'])
  return [...new Set(tokens.flatMap((token) => /\p{Script=Han}/u.test(token)
    ? Array.from({ length: Math.max(0, token.length - 1) }, (_, index) => token.slice(index, index + 2)) : stop.has(token) ? [] : [token]))].slice(0, 256)
}

export function retrieveText(text: string, query: string): TextRetrieval {
  const terms = keywords(query)
  const hits: RetrievalHit[] = []
  const lines = text.split(/\r?\n/)
  let start = 0
  while (start < lines.length) {
    let end = start
    while (end + 1 < lines.length && lines[end + 1]!.trim() && end - start < 19) end++
    const body = lines.slice(start, end + 1).join('\n')
    const matches = terms.filter((term) => body.toLowerCase().includes(term))
    if (matches.length) hits.push({ startLine: start + 1, endLine: end + 1, text: body.slice(0, 2000),
      terms: matches, score: matches.length / terms.length, truncated: body.length > 2000 })
    start = end + 1
    while (start < lines.length && !lines[start]!.trim()) start++
  }
  return { kind: 'text_retrieval', method: 'keyword_overlap', judgment: false,
    hits: hits.sort((a, b) => b.score - a.score || a.startLine - b.startLine).slice(0, 8) }
}

export interface VersionDiff {
  format: 'unified'
  text: string
  truncated: boolean
  limit: number
  available: boolean
}

type Edit = { kind: ' ' | '+' | '-'; text: string }
const splitLines = (text: string): string[] => text.match(/[^\n]*\n|[^\n]+$/g) ?? []

function edits(before: string[], after: string[]): Edit[] {
  let prefix = 0
  while (prefix < Math.min(before.length, after.length) && before[prefix] === after[prefix]) prefix++
  let suffix = 0
  while (suffix < Math.min(before.length, after.length) - prefix && before[before.length - 1 - suffix] === after[after.length - 1 - suffix]) suffix++
  const a = before.slice(prefix, before.length - suffix), b = after.slice(prefix, after.length - suffix)
  const result: Edit[] = before.slice(0, prefix).map((text) => ({ kind: ' ', text }))
  // 大段重写退化成一个替换块，限制内存；仍保留完整统一 diff 语义。
  if ((a.length + 1) * (b.length + 1) > 500_000) {
    for (const text of a) result.push({ kind: '-', text })
    for (const text of b) result.push({ kind: '+', text })
  } else {
    const width = b.length + 1, lcs = new Uint32Array((a.length + 1) * width)
    for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) {
      lcs[i * width + j] = a[i] === b[j] ? 1 + lcs[(i + 1) * width + j + 1]! : Math.max(lcs[(i + 1) * width + j]!, lcs[i * width + j + 1]!)
    }
    let i = 0, j = 0
    while (i < a.length || j < b.length) {
      if (i < a.length && j < b.length && a[i] === b[j]) { result.push({ kind: ' ', text: a[i++]! }); j++ }
      else if (i < a.length && (j === b.length || lcs[(i + 1) * width + j]! >= lcs[i * width + j + 1]!)) result.push({ kind: '-', text: a[i++]! })
      else result.push({ kind: '+', text: b[j++]! })
    }
  }
  for (let index = before.length - suffix; index < before.length; index++) result.push({ kind: ' ', text: before[index]! })
  return result
}

export function unifiedDiff(before: string | undefined, after: string | undefined, from: string, to: string, limit = 16_000): VersionDiff {
  const base = { format: 'unified' as const, limit, truncated: false, available: before !== undefined && after !== undefined }
  if (!base.available || before === after) return { ...base, text: '' }
  const operations = edits(splitLines(before!), splitLines(after!))
  const ranges: Array<{ start: number; end: number }> = []
  for (const [index, edit] of operations.entries()) {
    if (edit.kind === ' ') continue
    const start = Math.max(0, index - 3), end = Math.min(operations.length, index + 4)
    const last = ranges.at(-1)
    if (last && start <= last.end) last.end = end
    else ranges.push({ start, end })
  }
  let text = `--- ${from}\n+++ ${to}\n`, cursor = 0, oldLine = 1, newLine = 1
  for (const range of ranges) {
    while (cursor < range.start) { const edit = operations[cursor++]!; if (edit.kind !== '+') oldLine++; if (edit.kind !== '-') newLine++ }
    const block = operations.slice(range.start, range.end)
    const oldCount = block.filter((edit) => edit.kind !== '+').length, newCount = block.filter((edit) => edit.kind !== '-').length
    text += `@@ -${oldCount ? oldLine : oldLine - 1},${oldCount} +${newCount ? newLine : newLine - 1},${newCount} @@\n`
    for (const edit of block) {
      text += edit.kind + edit.text + (edit.text.endsWith('\n') ? '' : '\n\\ No newline at end of file\n')
      if (text.length > limit) return { ...base, text: text.slice(0, limit), truncated: true }
    }
    oldLine += oldCount; newLine += newCount; cursor = range.end
  }
  return { ...base, text: text.slice(0, limit), truncated: text.length > limit }
}
