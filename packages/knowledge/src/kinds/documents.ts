import { readSource } from './source-reader.js'
import { extname } from 'node:path'
import {
  parseFrontmatter,
  sha256,
  type KnowledgeBase,
  type KnowledgeKindContext,
} from '@taktflow/core'
import { collectDocumentSourcePaths } from './source-paths.js'
export interface Document {
  ref: string
  title: string
  text: string
  path?: string
  hash: string
  aliases?: string[]
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
    for (const { full, path, relative } of await collectDocumentSourcePaths({ ...kb, config: { sources: [source] } }, ctx)) {
      const raw = await readSource(full, ctx)
      const ref =
        source.type === 'upload'
          ? relative
          : [source.repo ?? source.path, relative].filter(Boolean).join('/')
      result.push({ ...parseDocument(raw, ref || full), path, hash: sha256(raw) })
    }
  }
  return result
}
