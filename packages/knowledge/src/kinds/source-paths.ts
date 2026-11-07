import { stat } from 'node:fs/promises'
import { dirname, relative } from 'node:path'
import { listFiles, type KnowledgeBase, type KnowledgeKindContext } from '@taktflow/core'
import { repositoryPath, safePath } from '../store/files.js'

export const STALE_SOURCE_SCAN_LIMIT = 10000

const defaultDocumentGlobs = ['**/*.md', '**/*.txt', '**/*.html', '**/*.json', '**/*.csv']

export interface SourcePath {
  full: string
  path: string
  relative: string
}

function manifestPath(kb: KnowledgeBase, ctx: KnowledgeKindContext, path: string): string {
  if (kb.scope === 'shared') return relative(dirname(ctx.baseDir), path)
  const projectRelative = relative(ctx.stores.projectDir, path)
  return !projectRelative.startsWith('..') ? projectRelative : relative(ctx.baseDir, path)
}

export async function collectDocumentSourcePaths(
  kb: KnowledgeBase,
  ctx: KnowledgeKindContext,
  options: { limit?: number } = {},
): Promise<SourcePath[]> {
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
  const result: SourcePath[] = []
  for (const source of sources) {
    ctx.signal?.throwIfAborted()
    if (options.limit && result.length >= options.limit) return result
    if (source.type === 'url') continue
    let root: string
    if (source.type === 'upload') root = await safePath(ctx.baseDir, 'content')
    else if (source.type === 'path') root = await safePath(ctx.stores.projectDir, source.path ?? '.')
    else if (source.type === 'repo') root = await repositoryPath(ctx.stores, String(source.repo))
    else throw new Error('数据源类型不支持，请选择 upload、path、repo 或 url')
    let paths: string[]
    try {
      const info = await stat(root)
      paths = info.isFile()
        ? ['']
        : await listFiles(root, typeof source.glob === 'string' ? [source.glob] : (source.glob ?? defaultDocumentGlobs), {
            limit: options.limit ? Math.max(1, options.limit - result.length) : undefined,
          })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' && source.type === 'upload') continue
      throw error
    }
    for (const path of paths) {
      const full = await safePath(root, path)
      result.push({ full, path: manifestPath(kb, ctx, full), relative: path })
      if (options.limit && result.length >= options.limit) return result
    }
  }
  return result
}

export async function collectMarkdownSourcePaths(
  root: string,
  kb: KnowledgeBase,
  ctx: KnowledgeKindContext,
  options: { limit?: number } = {},
): Promise<SourcePath[]> {
  const files = await listFiles(root, ['**/*.md'], { limit: options.limit })
  return Promise.all(
    files.map(async (file) => {
      const full = await safePath(root, file)
      return { full, path: manifestPath(kb, ctx, full), relative: file }
    }),
  )
}

export async function collectCurrentSourcePaths(
  kb: KnowledgeBase,
  ctx: KnowledgeKindContext,
  options: { limit?: number } = {},
): Promise<SourcePath[]> {
  if (kb.kind === 'rag') return collectDocumentSourcePaths(kb, ctx, options)
  if (kb.kind !== 'llm-wiki') return []
  if (kb.config.source === 'git') return []
  const root =
    kb.config.source === 'path'
      ? await safePath(ctx.stores.projectDir, String(kb.config.path ?? '.'))
      : await safePath(ctx.baseDir, 'content')
  try {
    return await collectMarkdownSourcePaths(root, kb, ctx, options)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}
