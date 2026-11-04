import { constants } from 'node:fs'
import { lstat, open, readdir } from 'node:fs/promises'
import { basename, join, relative, sep } from 'node:path'
import type { KnowledgeHit, KnowledgeQuery } from '@taktflow/core'

interface MarkdownPage {
  ref: string
  title: string
  aliases: string[]
  summary: string
  verifiedAt?: string
  body: string
}

export function tokenize(text: string): string[] {
  const tokens: string[] = []
  for (const part of text.toLowerCase().match(/\p{Script=Han}+|[a-z0-9]+/gu) ?? []) {
    if (/\p{Script=Han}/u.test(part)) {
      const chars = [...part]
      if (chars.length === 1) tokens.push(part)
      for (let i = 0; i < chars.length - 1; i++) tokens.push(chars[i]! + chars[i + 1]!)
    } else {
      tokens.push(part)
    }
  }
  return [...new Set(tokens)]
}

export function keywordScore(text: string, keywords: string[]): number {
  const words = new Set(tokenize(text))
  return keywords.reduce((score, word) => score + Number(words.has(word)), 0)
}

function withoutComment(value: string): string {
  let quote = ''
  for (let i = 0; i < value.length; i++) {
    const char = value[i]!
    if (quote === '"' && char === '\\') { i++; continue }
    if (quote === "'" && char === "'" && value[i + 1] === "'") { i++; continue }
    if (quote && char === quote) quote = ''
    else if (!quote && (char === '"' || char === "'")) quote = char
    else if (!quote && char === '#' && (i === 0 || /\s/.test(value[i - 1]!))) return value.slice(0, i).trim()
  }
  return value.trim()
}

function scalar(value: string): string {
  const text = withoutComment(value)
  if (text.startsWith('"') && text.endsWith('"')) {
    try {
      return JSON.parse(text) as string
    } catch {
      return text.slice(1, -1)
    }
  }
  if (text.startsWith("'") && text.endsWith("'")) return text.slice(1, -1).replace(/''/g, "'")
  return text
}

function inlineAliases(value: string): string[] {
  // 逗号只分隔数组项，不拆开引号中的别名。
  const text = value.slice(1, value.lastIndexOf(']'))
  const items: string[] = []
  let quote = ''
  let start = 0
  for (let i = 0; i < text.length; i++) {
    const char = text[i]!
    if (quote === '"' && char === '\\') { i++; continue }
    if (quote === "'" && char === "'" && text[i + 1] === "'") { i++; continue }
    if (quote && char === quote) quote = ''
    else if (!quote && (char === '"' || char === "'")) quote = char
    else if (!quote && char === ',') {
      items.push(text.slice(start, i))
      start = i + 1
    }
  }
  items.push(text.slice(start))
  return items.map(scalar).filter(Boolean)
}

function parseMarkdown(content: string, ref: string): MarkdownPage {
  const lines = content.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').split('\n')
  let body = lines.join('\n')
  let aliases: string[] = []
  let summary = ''
  let verifiedAt: string | undefined
  const end = lines[0]?.trim() === '---'
    ? lines.findIndex((line, index) => index > 0 && /^(---|\.\.\.)\s*$/.test(line))
    : -1
  if (end > 0) {
    body = lines.slice(end + 1).join('\n')
    for (let i = 1; i < end; i++) {
      const field = /^(aliases|summary|verifiedAt):\s*(.*)$/.exec(lines[i]!)
      if (!field) continue
      const key = field[1]!
      const value = withoutComment(field[2]!)
      if (key === 'verifiedAt') verifiedAt = scalar(value)
      if (key === 'aliases') {
        if (value.startsWith('[')) aliases = inlineAliases(value)
        else if (value) aliases = [scalar(value)]
        else {
          while (i + 1 < end) {
            const next = lines[i + 1]!
            if (!next.trim() || /^\s*#/.test(next)) { i++; continue }
            const item = /^\s*-\s+(.+)$/.exec(next)
            if (!item) break
            aliases.push(scalar(item[1]!))
            i++
          }
        }
      }
      if (key === 'summary') {
        if (/^[|>][+-]?[1-9]?$|^[|>][1-9][+-]?$/.test(value)) {
          const block: string[] = []
          while (i + 1 < end && (/^\s/.test(lines[i + 1]!) || !lines[i + 1]!.trim())) {
            block.push(lines[++i]!)
          }
          const indent = Math.min(...block.filter(line => line.trim()).map(line => /^\s*/.exec(line)![0].length))
          const text = block.map(line => line.slice(indent)).join('\n').trim()
          summary = value.startsWith('>') ? text.replace(/([^\n])\n(?=[^\n])/g, '$1 ') : text
        } else summary = scalar(value)
      }
    }
  }
  // fenced code 中的 # 不是页面标题。
  let fence: string | undefined
  let title: string | undefined
  const bodyLines = body.split('\n')
  for (let i = 0; i < bodyLines.length; i++) {
    const line = bodyLines[i]!
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1]
    if (marker) {
      if (!fence) fence = marker
      else if (marker[0] === fence[0] && marker.length >= fence.length) fence = undefined
      continue
    }
    if (fence) continue
    const heading = /^ {0,3}#\s+(.+?)\s*#*\s*$/.exec(line)?.[1]
    if (heading) { title = heading; break }
    if (line.trim() && /^ {0,3}=+\s*$/.test(bodyLines[i + 1] ?? '')) { title = line.trim(); break }
  }
  return { ref, title: title ?? basename(ref, '.md'), aliases, summary, verifiedAt, body }
}

function fileError(action: string, path: string, cause: unknown): Error {
  return new Error(`${action} ${path}: ${cause instanceof Error ? cause.message : String(cause)}`, { cause })
}

export async function directoryEntries(path: string) {
  try {
    const stat = await lstat(path)
    if (stat.isSymbolicLink()) return []
    return await readdir(path, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw fileError('读取目录失败', path, error)
  }
}

export async function markdownPages(root: string, refRoot = root): Promise<MarkdownPage[]> {
  const pages: MarkdownPage[] = []
  for (const entry of await directoryEntries(root)) {
    const path = join(root, entry.name)
    if (entry.isSymbolicLink()) continue
    if (entry.isDirectory()) pages.push(...await markdownPages(path, refRoot))
    else if (entry.isFile() && /\.md$/i.test(entry.name)) {
      try {
        // 防止枚举之后文件被替换成 symlink 时越过检索边界。
        const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
        try {
          const content = await file.readFile('utf8')
          pages.push(parseMarkdown(content, relative(refRoot, path).split(sep).join('/')))
        } finally {
          await file.close()
        }
      } catch (error) {
        throw fileError('读取 Markdown 失败', path, error)
      }
    }
  }
  return pages
}

function evidenceLevel(value: string | undefined, now: number): KnowledgeHit['evidenceLevel'] {
  if (!value || !/^\d{4}-\d{2}-\d{2}(?:T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d))?$/.test(value)) return 'derived'
  const date = value.slice(0, 10)
  const calendarDate = new Date(`${date}T00:00:00Z`)
  const time = Date.parse(value)
  // Date.parse 会把 2 月 30 日归一化到 3 月，不能把这种输入当成已验证。
  if (!Number.isFinite(time) || !Number.isFinite(calendarDate.getTime()) || calendarDate.toISOString().slice(0, 10) !== date || time > now) return 'derived'
  return now - time <= 30 * 24 * 60 * 60 * 1000 ? 'verified' : 'stale'
}

function snippetFor(page: MarkdownPage, keywords: string[]): { snippet: string; score: number } {
  const paragraphs = page.body.split(/\n\s*\n/).map(text => text.trim())
    .filter(text => text && !/^#{1,6}\s+[^\n]+$/.test(text))
  const best = paragraphs.map(text => ({ text, score: keywordScore(text, keywords) }))
    .sort((a, b) => b.score - a.score)[0]
  const text = best?.score ? best.text : page.summary || best?.text || page.title
  const firstMatch = keywords.map(word => {
    if (/\p{Script=Han}/u.test(word)) return text.indexOf(word)
    const match = new RegExp(`(^|[^a-z0-9])(${word})(?=$|[^a-z0-9])`, 'i').exec(text)
    return match ? match.index + match[1]!.length : -1
  }).filter(index => index >= 0)
  const start = text.length > 600 && firstMatch.length ? Math.max(0, Math.min(...firstMatch) - 100) : 0
  return { snippet: text.slice(start, start + 600), score: best?.score ?? 0 }
}

export function rankMarkdown(pages: MarkdownPage[], q: KnowledgeQuery, sourceId: string): KnowledgeHit[] {
  const keywords = tokenize(q.text)
  const limit = q.limit === undefined ? 8 : Math.max(0, Math.floor(q.limit))
  if (!keywords.length || !Number.isFinite(limit) || limit === 0) return []
  const entries = pages.filter(page => !q.scope?.length || q.scope.some(scope => {
    const prefix = scope.replace(/^\.\//, '').replace(/\/$/, '')
    return page.ref === prefix || page.ref.startsWith(`${prefix}/`)
  })).map(page => ({
    page,
    score: keywordScore(page.ref, keywords) + 3 * keywordScore(page.title, keywords)
      + 3 * keywordScore(page.aliases.join('\n'), keywords) + 2 * keywordScore(page.summary, keywords),
  })).filter(entry => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.page.ref.localeCompare(b.page.ref))
    // 先按入口召回有限候选，再让正文参与排序；正文不能扩大候选集合。
    .slice(0, Math.max(16, limit * 4))
  const now = Date.now()
  return entries.map(({ page, score }): KnowledgeHit => {
    const snippet = snippetFor(page, keywords)
    return {
      sourceId, title: page.title, ref: page.ref, snippet: snippet.snippet,
      score: score + snippet.score, evidenceLevel: evidenceLevel(page.verifiedAt, now),
      fetchedAt: new Date(now).toISOString(),
    }
  }).sort((a, b) => b.score! - a.score! || a.ref.localeCompare(b.ref)).slice(0, limit)
}
