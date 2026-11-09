/**
 * 轻量 Markdown 解析：把文本切成块（标题、段落、列表、代码块、表格、引用、分隔线），行内格式留给渲染层。
 * 列表项的正文按块递归解析，所以项里能嵌子列表、表格、代码块。
 *
 * 每个循环每轮至少吃掉一行：Agent 写的文档缩进常常不规整（子项比首项缩进浅、表格夹在列表中间），
 * 解析器遇到看不懂的结构只能退化成段落或另起列表，不能卡住页面。
 */

export type Align = 'left' | 'center' | 'right' | undefined

export type MdBlock =
  | { type: 'heading'; level: 1 | 2 | 3 | 4; text: string }
  | { type: 'paragraph'; text: string }
  | { type: 'hr' }
  | { type: 'code'; lang: string; code: string }
  | { type: 'quote'; blocks: MdBlock[] }
  | { type: 'table'; head: string[]; align: Align[]; rows: string[][] }
  | { type: 'list'; ordered: boolean; start: number; items: MdListItem[] }

export interface MdListItem {
  text: string
  blocks: MdBlock[]
}

const LIST_RE = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/
const FENCE_RE = /^(\s{0,3})```\s*([\w+-]*)/
const HEADING_RE = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/
const HR_RE = /^\s{0,3}(-{3,}|\*{3,}|_{3,})\s*$/
const QUOTE_RE = /^\s{0,3}>/
const TABLE_SEP_RE = /^\s*\|?\s*:?-{2,}/

const indentOf = (line: string) => line.length - line.trimStart().length
const isBlank = (line: string) => line.trim() === ''
const isTableStart = (lines: string[], i: number) => lines[i]!.includes('|') && i + 1 < lines.length && TABLE_SEP_RE.test(lines[i + 1]!)
const startsBlock = (lines: string[], i: number) => {
  const line = lines[i]!
  return FENCE_RE.test(line) || HEADING_RE.test(line) || HR_RE.test(line) || QUOTE_RE.test(line) || LIST_RE.test(line) || isTableStart(lines, i)
}

export const splitRow = (line: string) =>
  line
    .trim()
    .replace(/^\||\|$/g, '')
    .split('|')
    .map((c) => c.trim())

export function parseMarkdown(source: string): MdBlock[] {
  const lines = source
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((l) => l.replace(/^\t+/, (tabs) => '    '.repeat(tabs.length)))
  try {
    return parseBlocks(lines)
  } catch {
    // 解析器自身出错时原样显示，不让整页渲染失败
    return [{ type: 'code', lang: '', code: source }]
  }
}

function parseBlocks(lines: string[]): MdBlock[] {
  const blocks: MdBlock[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]!
    if (isBlank(line)) {
      i++
      continue
    }
    const fence = FENCE_RE.exec(line)
    if (fence) {
      const strip = fence[1]!.length
      const body: string[] = []
      i++
      while (i < lines.length && !/^\s*```/.test(lines[i]!)) {
        const raw = lines[i++]!
        body.push(raw.slice(Math.min(strip, indentOf(raw))))
      }
      i++
      blocks.push({ type: 'code', lang: fence[2] ?? '', code: body.join('\n') })
      continue
    }
    const h = HEADING_RE.exec(line)
    if (h) {
      blocks.push({ type: 'heading', level: Math.min(h[1]!.length, 4) as 1 | 2 | 3 | 4, text: h[2]! })
      i++
      continue
    }
    if (HR_RE.test(line)) {
      blocks.push({ type: 'hr' })
      i++
      continue
    }
    if (QUOTE_RE.test(line)) {
      const body: string[] = []
      while (i < lines.length && QUOTE_RE.test(lines[i]!)) body.push(lines[i++]!.replace(/^\s{0,3}>\s?/, ''))
      blocks.push({ type: 'quote', blocks: parseBlocks(body) })
      continue
    }
    if (isTableStart(lines, i)) {
      const head = splitRow(line)
      const align = splitRow(lines[i + 1]!).map((c): Align => (c.endsWith(':') ? (c.startsWith(':') ? 'center' : 'right') : undefined))
      i += 2
      const rows: string[][] = []
      while (i < lines.length && lines[i]!.includes('|') && !isBlank(lines[i]!)) rows.push(splitRow(lines[i++]!))
      blocks.push({ type: 'table', head, align, rows })
      continue
    }
    if (LIST_RE.test(line)) {
      const { block, next } = parseList(lines, i)
      blocks.push(block)
      i = next
      continue
    }
    const para: string[] = [line.trim()]
    i++
    while (i < lines.length && !isBlank(lines[i]!) && !startsBlock(lines, i)) para.push(lines[i++]!.trim())
    blocks.push({ type: 'paragraph', text: para.join(' ') })
  }
  return blocks
}

/**
 * 从 start 行起解析一个列表，返回列表和下一行的位置（至少前进一行）。
 * 和首项同缩进（差一个空格也算）、同类型（有序 / 无序）的才是同级项；比首项浅或换了类型就结束，
 * 交给外层另起一块。比首项深的行都归上一项，去掉公共缩进后按块递归解析。
 */
function parseList(lines: string[], start: number): { block: MdBlock; next: number } {
  const first = LIST_RE.exec(lines[start]!)!
  const indent = first[1]!.length
  const ordered = /\d/.test(first[2]!)
  const items: MdListItem[] = []
  let i = start
  const sibling = (line: string) => {
    const m = LIST_RE.exec(line)
    if (!m) return undefined
    const level = m[1]!.length
    return level >= indent && level <= indent + 1 && /\d/.test(m[2]!) === ordered ? m : undefined
  }
  while (i < lines.length) {
    // 项之间隔空行（松散列表）仍是同一个列表，编号不断
    let j = i
    while (j < lines.length && isBlank(lines[j]!)) j++
    const m = j < lines.length ? sibling(lines[j]!) : undefined
    if (!m) break
    i = j + 1
    const body: string[] = []
    while (i < lines.length) {
      const line = lines[i]!
      if (isBlank(line)) {
        let j = i + 1
        while (j < lines.length && isBlank(lines[j]!)) j++
        if (j < lines.length && belongsToItem(lines[j]!, indent)) {
          body.push(...lines.slice(i, j))
          i = j
          continue
        }
        break
      }
      if (!belongsToItem(line, indent)) break
      body.push(line)
      i++
    }
    items.push(parseItem(m[3]!, body))
  }
  return { block: { type: 'list', ordered, start: ordered ? parseInt(first[2]!, 10) : 1, items }, next: Math.max(i, start + 1) }
}

/** 比项标记更深的行归这一项；但差一个空格的列表行算同级（Agent 常见的缩进抖动）。 */
function belongsToItem(line: string, indent: number): boolean {
  const level = indentOf(line)
  if (LIST_RE.test(line)) return level >= indent + 2
  return level > indent
}

function parseItem(text: string, body: string[]): MdListItem {
  const common = Math.min(...body.filter((l) => !isBlank(l)).map(indentOf))
  const rest = body.map((l) => (isBlank(l) ? '' : l.slice(common)))
  // 紧跟标记行的普通文字是同一段的续行
  const head = [text.trim()]
  let i = 0
  while (i < rest.length && !isBlank(rest[i]!) && !startsBlock(rest, i)) head.push(rest[i++]!.trim())
  return { text: head.filter(Boolean).join(' '), blocks: parseBlocks(rest.slice(i)) }
}
