export interface DiffLine {
  kind: 'same' | 'add' | 'del'
  text: string
  /** 旧 / 新文件里的行号（1 起）。 */
  a?: number
  b?: number
}

export interface DiffHunk {
  lines: DiffLine[]
  /** 折叠掉的相同行数（hunk 之前）。 */
  skipped: number
}

/** 逐行 LCS diff。产物是文档级别（几百行），O(n·m) 足够。 */
export function lineDiff(before: string, after: string): DiffLine[] {
  const a = before.split('\n')
  const b = after.split('\n')
  const n = a.length
  const m = b.length
  const lcs: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1))
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!)
  const out: DiffLine[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ kind: 'same', text: a[i]!, a: i + 1, b: j + 1 })
      i++
      j++
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
      out.push({ kind: 'del', text: a[i]!, a: i + 1 })
      i++
    } else {
      out.push({ kind: 'add', text: b[j]!, b: j + 1 })
      j++
    }
  }
  for (; i < n; i++) out.push({ kind: 'del', text: a[i]!, a: i + 1 })
  for (; j < m; j++) out.push({ kind: 'add', text: b[j]!, b: j + 1 })
  return out
}

/** 只保留改动附近 context 行，其余折叠。 */
export function hunks(lines: DiffLine[], context = 2): DiffHunk[] {
  const keep = new Uint8Array(lines.length)
  lines.forEach((l, i) => {
    if (l.kind === 'same') return
    for (let k = Math.max(0, i - context); k <= Math.min(lines.length - 1, i + context); k++) keep[k] = 1
  })
  const out: DiffHunk[] = []
  let skipped = 0
  let cur: DiffHunk | undefined
  lines.forEach((l, i) => {
    if (!keep[i]) {
      skipped++
      cur = undefined
      return
    }
    if (!cur) {
      cur = { lines: [], skipped }
      out.push(cur)
      skipped = 0
    }
    cur.lines.push(l)
  })
  return out
}

export const diffStat = (lines: DiffLine[]) => ({ add: lines.filter((l) => l.kind === 'add').length, del: lines.filter((l) => l.kind === 'del').length })
