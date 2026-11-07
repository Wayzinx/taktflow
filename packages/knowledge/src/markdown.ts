import { constants } from 'node:fs'
import { lstat, open, readdir } from 'node:fs/promises'
import { basename, join, relative, sep } from 'node:path'
import { parseFrontmatter } from '@taktflow/core'
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
      for (let index2 = 0; index2 < chars.length - 1; index2++)
        tokens.push(chars[index2]! + chars[index2 + 1]!)
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

function parseMarkdown(content: string, ref: string): MarkdownPage {
  const { data, body } = parseFrontmatter(content.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n'))
  const aliasValues = Array.isArray(data.aliases) ? data.aliases : [data.aliases]
  const aliases = aliasValues
    .filter((value): value is string => typeof value === 'string')
    .map((value) => value.trim())
    .filter(Boolean)
  const summary = typeof data.summary === 'string' ? data.summary.trim() : ''
  const verifiedAt = typeof data.verifiedAt === 'string' ? data.verifiedAt.trim() : undefined
  // fenced code 中的 # 不是页面标题。
  let fence: string | undefined
  let title: string | undefined
  const bodyLines = body.split('\n')
  for (let index3 = 0; index3 < bodyLines.length; index3++) {
    const line = bodyLines[index3]!
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1]
    if (marker) {
      if (!fence) fence = marker
      else if (marker[0] === fence[0] && marker.length >= fence.length) fence = undefined
      continue
    }
    if (fence) continue
    const heading = /^ {0,3}#\s+(.+?)\s*#*\s*$/.exec(line)?.[1]
    if (heading) {
      title = heading
      break
    }
    if (line.trim() && /^ {0,3}=+\s*$/.test(bodyLines[index3 + 1] ?? '')) {
      title = line.trim()
      break
    }
  }
  return { ref, title: title ?? basename(ref, '.md'), aliases, summary, verifiedAt, body }
}

function fileError(action: string, path: string, cause: unknown): Error {
  return new Error(`${action} ${path}: ${cause instanceof Error ? cause.message : String(cause)}`, {
    cause,
  })
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
    if (entry.isDirectory()) pages.push(...(await markdownPages(path, refRoot)))
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
  if (
    !value ||
    !/^\d{4}-\d{2}-\d{2}(?:T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d))?$/.test(
      value,
    )
  )
    return 'derived'
  const date = value.slice(0, 10)
  const calendarDate = new Date(`${date}T00:00:00Z`)
  const time = Date.parse(value)
  // Date.parse 会把 2 月 30 日归一化到 3 月，不能把这种输入当成已验证。
  if (
    !Number.isFinite(time) ||
    !Number.isFinite(calendarDate.getTime()) ||
    calendarDate.toISOString().slice(0, 10) !== date ||
    time > now
  )
    return 'derived'
  return now - time <= 30 * 24 * 60 * 60 * 1000 ? 'verified' : 'stale'
}

function snippetFor(page: MarkdownPage, keywords: string[]): { snippet: string; score: number } {
  const paragraphs = page.body
    .split(/\n\s*\n/)
    .map((text) => text.trim())
    .filter((text) => text && !/^#{1,6}\s+[^\n]+$/.test(text))
  const best = paragraphs
    .map((text) => ({ text, score: keywordScore(text, keywords) }))
    .sort((left, right) => right.score - left.score)[0]
  const text = best?.score ? best.text : page.summary || best?.text || page.title
  const firstMatch = keywords
    .map((word) => {
      if (/\p{Script=Han}/u.test(word)) return text.indexOf(word)
      const match = new RegExp(`(^|[^a-z0-9])(${word})(?=$|[^a-z0-9])`, 'i').exec(text)
      return match ? match.index + match[1]!.length : -1
    })
    .filter((index) => index >= 0)
  const start =
    text.length > 600 && firstMatch.length ? Math.max(0, Math.min(...firstMatch) - 100) : 0
  return { snippet: text.slice(start, start + 600), score: best?.score ?? 0 }
}

export function rankMarkdown(
  pages: MarkdownPage[],
  query: KnowledgeQuery,
  sourceId: string,
): KnowledgeHit[] {
  const keywords = tokenize(query.text)
  const limit = query.limit === undefined ? 8 : Math.max(0, Math.floor(query.limit))
  if (!keywords.length || !Number.isFinite(limit) || limit === 0) return []
  const entries = pages
    .filter(
      (page) =>
        !query.scope?.length ||
        query.scope.some((scope) => {
          const prefix = scope.replace(/^\.\//, '').replace(/\/$/, '')
          return page.ref === prefix || page.ref.startsWith(`${prefix}/`)
        }),
    )
    .map((page) => ({
      page,
      score:
        keywordScore(page.ref, keywords) +
        3 * keywordScore(page.title, keywords) +
        3 * keywordScore(page.aliases.join('\n'), keywords) +
        2 * keywordScore(page.summary, keywords),
    }))
    .filter((entry) => entry.score > 0)
    .sort(
      (left2, right2) =>
        right2.score - left2.score || left2.page.ref.localeCompare(right2.page.ref),
    )
    // 先按入口召回有限候选，再让正文参与排序；正文不能扩大候选集合。
    .slice(0, Math.max(16, limit * 4))
  const now = Date.now()
  return entries
    .map(({ page, score }): KnowledgeHit => {
      const snippet = snippetFor(page, keywords)
      return {
        sourceId,
        title: page.title,
        ref: page.ref,
        snippet: snippet.snippet,
        score: score + snippet.score,
        evidenceLevel: evidenceLevel(page.verifiedAt, now),
        fetchedAt: new Date(now).toISOString(),
      }
    })
    .sort((hit, hit2) => hit2.score! - hit.score! || hit.ref.localeCompare(hit2.ref))
    .slice(0, limit)
}
