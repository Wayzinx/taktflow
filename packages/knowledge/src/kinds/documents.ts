import { readSource } from './source-reader.js'
import { stat } from 'node:fs/promises'
import { dirname, extname, relative } from 'node:path'
import {
  listFiles,
  parseFrontmatter,
  sha256,
  type KnowledgeBase,
  type KnowledgeKindContext,
} from '@taktflow/core'
import { safePath, repositoryPath } from '../store/files.js'
export interface Document {
  ref: string
  title: string
  text: string
  path?: string
  hash: string
  aliases?: string[]
}
function manifestPath(kb: KnowledgeBase, ctx: KnowledgeKindContext, path: string): string {
  if (kb.scope === 'shared') return relative(dirname(ctx.baseDir), path)
  const projectRelative = relative(ctx.stores.projectDir, path)
  return !projectRelative.startsWith('..') ? projectRelative : relative(ctx.baseDir, path)
}
export async function fetchText(
  url: string,
  ctx: KnowledgeKindContext,
  headers?: Record<string, string>,
  maxBytes = 200 * 1024,
): Promise<string> {
  if (ctx.stores.config.sandbox?.network === 'none')
    throw new Error('空间禁止网络访问，请修改网络策略后重试')
  if (!/^https?:\/\//i.test(url)) throw new Error('只支持 HTTP(S) 地址，请检查 URL')
  const parsedUrl = new URL(url)
  if (parsedUrl.username || parsedUrl.password)
    throw new Error('URL 不允许携带认证信息，请使用密钥引用')
  const signal = ctx.signal
    ? AbortSignal.any([ctx.signal, AbortSignal.timeout(8000)])
    : AbortSignal.timeout(8000)
  const response = await fetch(url, { headers, signal, redirect: 'error' })
  if (!response.ok)
    throw new Error(`读取远程数据失败（HTTP ${response.status}），请检查地址和访问权限`)
  const reader = response.body?.getReader()
  const chunks: Buffer[] = []
  let bytes = 0
  if (!reader) return ''
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      bytes += value.length
      if (bytes > maxBytes) {
        chunks.push(Buffer.from(value.slice(0, maxBytes - (bytes - value.length))))
        await reader.cancel()
        break
      }
      chunks.push(Buffer.from(value))
    }
  } finally {
    reader.releaseLock()
  }
  return Buffer.concat(chunks).toString('utf8')
}
function parseDocument(raw: string, ref: string): Omit<Document, 'hash'> {
  try {
    return parseContent(raw, ref)
  } catch {
    throw Object.assign(new Error(`文档 ${ref} 解析失败，请检查文件格式后重试`), { ref })
  }
}
function parseContent(raw: string, ref: string): Omit<Document, 'hash'> {
  const extension = extname(ref.split('?')[0]!).toLowerCase()
  let title = ref
  let text = raw
  let aliases: string[] | undefined
  if (extension === '.md') {
    const parsed = parseFrontmatter(raw)
    text = parsed.body
    title = String(parsed.data.title ?? /^#\s+(.+)$/m.exec(text)?.[1] ?? ref)
    aliases = Array.isArray(parsed.data.aliases) ? parsed.data.aliases.map(String) : []
  } else if (extension === '.html' || extension === '.htm') {
    title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(raw)?.[1] ?? ref
    text = raw
      .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
  } else if (extension === '.json') text = JSON.stringify(JSON.parse(raw), null, 2)
  else if (extension === '.csv')
    text = raw
      .split(/\r?\n/)
      .map((line, index, rows) =>
        index && index % 20 === 0 ? `\n# 行 ${index + 1}\n${rows[0]}\n${line}` : line,
      )
      .join('\n')
  return { ref, title, text, aliases }
}
export async function documents(kb: KnowledgeBase, ctx: KnowledgeKindContext): Promise<Document[]> {
  const sources = (kb.config.sources as
    | Array<{
        type: string
        path?: string
        repo?: string
        glob?: string | string[]
        urls?: string[]
        url?: string
      }>
    | undefined) ?? [{ type: 'upload' }]
  const result: Document[] = []
  for (const source of sources) {
    ctx.signal?.throwIfAborted()
    if (source.type === 'url') {
      for (const url of source.urls ?? (source.url ? [source.url] : [])) {
        const raw = await fetchText(url, ctx, undefined, 8 * 1024 * 1024)
        result.push({ ...parseDocument(raw, url), hash: sha256(raw) })
      }
      continue
    }
    let root: string
    if (source.type === 'upload') root = await safePath(ctx.baseDir, 'content')
    else if (source.type === 'path')
      root = await safePath(ctx.stores.projectDir, source.path ?? '.')
    else if (source.type === 'repo') {
      const repo = ctx.stores.config.repos?.find((record) => record.id === source.repo)
      if (!repo) throw new Error('仓库未绑定，请先在空间中绑定仓库')
      root = await repositoryPath(ctx.stores, repo.id)
    } else throw new Error('数据源类型不支持，请选择 upload、path、repo 或 url')
    let paths: string[]
    try {
      const info = await stat(root)
      paths = info.isFile()
        ? ['']
        : await listFiles(
            root,
            typeof source.glob === 'string'
              ? [source.glob]
              : (source.glob ?? ['**/*.md', '**/*.txt', '**/*.html', '**/*.json', '**/*.csv']),
          )
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' && source.type === 'upload') continue
      throw error
    }
    for (const path of paths) {
      const full = await safePath(root, path)
      const raw = await readSource(full, ctx)
      const ref =
        source.type === 'upload'
          ? path
          : [source.repo ?? source.path, path].filter(Boolean).join('/')
      result.push({ ...parseDocument(raw, ref || root), path: manifestPath(kb, ctx, full), hash: sha256(raw) })
    }
  }
  return result
}
