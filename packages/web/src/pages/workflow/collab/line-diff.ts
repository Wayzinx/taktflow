/** 行级 diff 与统一 diff 解析：修订抽屉、冲突对话框共用。workflow 文件只有几百行，LCS 足够。 */

export interface DiffLine {
  t: ' ' | '+' | '-'
  text: string
  /** 在旧 / 新文件中的行号（1 起）；新增行没有 a，删除行没有 b。 */
  a?: number
  b?: number
}

/** 折叠后的一行：普通行，或"省略 n 行未改动"。 */
export type DiffRow = DiffLine | { t: 'gap'; count: number } | { t: '@'; text: string }

export function lineDiff(before: string, after: string): DiffLine[] {
  const x = before.split('\n')
  const y = after.split('\n')
  // 先剥掉公共前后缀，LCS 只算中间那段
  let p = 0
  while (p < x.length && p < y.length && x[p] === y[p]) p++
  let s = 0
  while (s < x.length - p && s < y.length - p && x[x.length - 1 - s] === y[y.length - 1 - s]) s++
  const xm = x.slice(p, x.length - s)
  const ym = y.slice(p, y.length - s)
  const dp = Array.from({ length: xm.length + 1 }, () => new Uint16Array(ym.length + 1))
  for (let i = xm.length - 1; i >= 0; i--)
    for (let j = ym.length - 1; j >= 0; j--) dp[i]![j] = xm[i] === ym[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!)

  const out: DiffLine[] = []
  for (let k = 0; k < p; k++) out.push({ t: ' ', text: x[k]!, a: k + 1, b: k + 1 })
  let i = 0
  let j = 0
  while (i < xm.length || j < ym.length) {
    if (i < xm.length && j < ym.length && xm[i] === ym[j]) out.push({ t: ' ', text: xm[i]!, a: p + ++i, b: p + ++j })
    else if (j < ym.length && (i >= xm.length || dp[i]![j + 1]! > dp[i + 1]![j]!)) out.push({ t: '+', text: ym[j]!, b: p + ++j })
    else out.push({ t: '-', text: xm[i]!, a: p + ++i })
  }
  for (let k = 0; k < s; k++) out.push({ t: ' ', text: x[x.length - s + k]!, a: x.length - s + k + 1, b: y.length - s + k + 1 })
  return out
}

/** 只保留改动附近 context 行，其余折叠成 gap。 */
export function collapse(lines: DiffLine[], context = 3): DiffRow[] {
  const keep = new Array<boolean>(lines.length).fill(false)
  lines.forEach((l, k) => {
    if (l.t === ' ') return
    for (let d = Math.max(0, k - context); d <= Math.min(lines.length - 1, k + context); d++) keep[d] = true
  })
  const out: DiffRow[] = []
  let gap = 0
  lines.forEach((l, k) => {
    if (keep[k]) {
      if (gap) out.push({ t: 'gap', count: gap })
      gap = 0
      out.push(l)
    } else gap++
  })
  if (gap) out.push({ t: 'gap', count: gap })
  return out
}

/** 解析统一 diff 文本（服务端 / 演示数据给的 diff 字段）。文件头丢掉，hunk 头保留。 */
export function parseUnifiedDiff(diff: string): DiffRow[] {
  const out: DiffRow[] = []
  let a = 0
  let b = 0
  for (const raw of diff.split('\n')) {
    if (raw.startsWith('--- ') || raw.startsWith('+++ ')) continue
    const h = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(raw)
    if (h) {
      a = Number(h[1])
      b = Number(h[2])
      out.push({ t: '@', text: raw })
      continue
    }
    if (raw === '' || raw.startsWith('\\')) continue
    const t = raw[0]
    const text = raw.slice(1)
    if (t === '+') out.push({ t: '+', text, b: b++ })
    else if (t === '-') out.push({ t: '-', text, a: a++ })
    else out.push({ t: ' ', text, a: a++, b: b++ })
  }
  return out
}

export function diffStats(rows: DiffRow[]): { added: number; removed: number } {
  let added = 0
  let removed = 0
  for (const r of rows) {
    if (r.t === '+') added++
    else if (r.t === '-') removed++
  }
  return { added, removed }
}

const MARK = /^(<{7}|={7}|>{7})( |$)/m

/** 合并文本里是否还留着冲突标记。 */
export const hasConflictMarkers = (text: string): boolean => MARK.test(text)

/** 冲突块数量（按 <<<<<<< 计）。 */
export const conflictCount = (text: string): number => text.split('\n').filter((l) => /^<{7}( |$)/.test(l)).length
