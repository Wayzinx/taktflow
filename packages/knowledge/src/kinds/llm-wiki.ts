import { readSource } from './source-reader.js'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { dirname, join, relative } from 'node:path'
import { mkdir, readFile } from 'node:fs/promises'
import { listFiles, parseFrontmatter, sha256, type KnowledgeKind } from '@taktflow/core'
import { safePath, repositoryPath } from '../store/files.js'
import { bm25, loadIndex, makeIndex, saveIndex, splitChunks, trimHits } from './search.js'
import { generateWiki, type WikiRuntime } from './wiki-run.js'
const execute = promisify(execFile)
export function createWikiKind(runtime?: WikiRuntime): KnowledgeKind {
  return {
    kind: 'llm-wiki',
    title: 'LLM Wiki',
    summary: '模块职责、业务流程和设计原因',
    intents: ['business', 'history', 'impact'],
    needsBuild: true,
    configSchema: {
      type: 'object',
      properties: {
        source: { type: 'string', enum: ['space', 'path', 'git'] },
        path: { type: 'string' },
        url: { type: 'string' },
        branch: { type: 'string' },
        generate: {
          type: 'object',
          required: ['repo'],
          properties: {
            repo: { type: 'string' },
            granularity: { type: 'string', enum: ['directory', 'module'] },
          },
        },
      },
    },
    async test(kb, ctx) {
      if (kb.config.generate) {
        const root = await repositoryPath(
          ctx.stores,
          String((kb.config.generate as { repo: string }).repo),
        )
        const files = await listFiles(
          root,
          (kb.config.generate as { include?: string[] }).include ?? ['**'],
        )
        return {
          ok: files.length > 0,
          message: '仓库可读；构建需要 wiki-writer、reviewer 和可用 harness，完成后人工发布',
          preview: files.slice(0, 5).map((file2) => ({ title: file2, ref: file2, snippet: file2 })),
        }
      }
      const path =
        kb.config.source === 'path'
          ? await safePath(ctx.stores.projectDir, String(kb.config.path ?? '.'))
          : await safePath(ctx.baseDir, 'content')
      if (kb.config.source === 'git')
        return {
          ok: /^https?:\/\//.test(String(kb.config.url)),
          message: '构建时检出 Git，请确认网络策略和仓库地址',
        }
      const files = await listFiles(path, ['**/*.md'])
      return {
        ok: files.length > 0,
        message: `发现 ${files.length} 个 Wiki 页面`,
        preview: files.slice(0, 5).map((file3) => ({ ref: file3, title: file3, snippet: file3 })),
      }
    },
    async build(kb, ctx, progress) {
      let root = await safePath(ctx.baseDir, 'content')
      if (kb.config.generate) {
        progress({ stage: 'generate', done: 0, total: 1 })
        root = await generateWiki(kb, ctx, runtime)
        progress({ stage: 'generate', done: 1, total: 1 })
      } else if (kb.config.source === 'path')
        root = await safePath(ctx.stores.projectDir, String(kb.config.path ?? '.'))
      else if (kb.config.source === 'git') {
        if (ctx.stores.config.sandbox?.network === 'none')
          throw new Error('空间禁止网络访问，请修改策略后重试')
        const url = String(kb.config.url)
        const branch = String(kb.config.branch ?? 'main')
        if (
          !/^https?:\/\//.test(url) ||
          new URL(url).username ||
          new URL(url).password ||
          branch.startsWith('-') ||
          /[\s~^:?*\[\\]/.test(branch)
        )
          throw new Error('Git 地址或分支不合法，请检查配置')
        root = await safePath(dirname(ctx.indexDir), 'repo')
        await mkdir(dirname(root), { recursive: true })
        try {
          await execute('git', ['-C', root, 'remote', 'set-url', 'origin', url], {
            signal: ctx.signal,
          })
          await execute('git', ['-C', root, 'fetch', '--depth=1', 'origin', branch], {
            signal: ctx.signal,
            timeout: 60000,
          })
        } catch {
          await execute('git', ['clone', '--depth=1', '--branch', branch, '--', url, root], {
            signal: ctx.signal,
            timeout: 60000,
          })
        }
        await execute('git', ['-C', root, 'checkout', '--detach', 'FETCH_HEAD'], {
          signal: ctx.signal,
          timeout: 60000,
        }).catch(async () => {
          await execute('git', ['-C', root, 'checkout', '--detach', 'HEAD'], { signal: ctx.signal })
        })
      }
      const files = await listFiles(root, ['**/*.md'])
      const chunks = []
      const manifest = []
      const navigation = await readFile(await safePath(root, 'index.md'), 'utf8').catch(() => '')
      for (const file of files) {
        ctx.signal?.throwIfAborted()
        const path = await safePath(root, file)
        const raw = await readSource(path, ctx)
        const parsed = parseFrontmatter(raw)
        const title = String(parsed.data.title ?? /^#\s+(.+)$/m.exec(parsed.body)?.[1] ?? file)
        const aliases = Array.isArray(parsed.data.aliases) ? parsed.data.aliases.map(String) : []
        for (const link of navigation.matchAll(/\[([^\]]+)\]\(([^)#]+)(?:#[^)]*)?\)/g))
          if (link[2]?.replace(/^\.\//, '') === file) aliases.push(link[1]!)
        const page = splitChunks(parsed.body, file, title)
        page.forEach((chunk, index2) => {
          const heading = chunk.title.split(' / ').at(-1)!
          chunk.ref = `${file}#${heading
            .toLowerCase()
            .replace(/[^\p{L}\p{N}]+/gu, '-')
            .replace(/^-|-$/g, '')}${index2 ? `-${index2}` : ''}`
        })
        const projectRelative = relative(ctx.stores.projectDir, path)
        const source = kb.scope === 'shared'
          ? relative(dirname(ctx.baseDir), path)
          : !projectRelative.startsWith('..')
            ? projectRelative
            : relative(ctx.baseDir, path)
        chunks.push(...page.map((chunk2) => ({ ...chunk2, aliases, source })))
        manifest.push({ path: source, hash: sha256(raw) })
      }
      const index = makeIndex(chunks)
      index.manifest = manifest
      await saveIndex(ctx.indexDir, index)
      progress({ stage: 'index', done: files.length, total: files.length })
      return {
        stats: {
          docs: files.length,
          pages: files.length,
          chunks: chunks.length,
          bytes: chunks.reduce((total2, chunk3) => total2 + Buffer.byteLength(chunk3.content), 0),
        },
      }
    },
    async query(kb, query2, ctx, retrieval) {
      const index = await loadIndex(ctx.indexDir)
      const scores = new Map(
        bm25(index, query2.text).map((record) => [record.i, record.score / (1 + record.score)]),
      )
      const query = query2.text.toLowerCase()
      index.chunks.forEach((chunk4, index3) => {
        const names = [chunk4.title.split(' / ')[0]!, ...(chunk4.aliases ?? [])].map((total3) =>
          total3.toLowerCase(),
        )
        const boost = names.includes(query)
          ? 3
          : names.some((total4) => total4.includes(query) || query.includes(total4))
            ? 2
            : 0
        if (boost) scores.set(index3, boost + (scores.get(index3) ?? 0))
      })
      return trimHits(
        [...scores]
          .sort((left, right) => right[1] - left[1])
          .map(([index4, score]) => {
            const chunk5 = index.chunks[index4]!
            return {
              sourceId: kb.id,
              ref: chunk5.ref,
              title: chunk5.title,
              snippet: chunk5.content,
              content: chunk5.content,
              score: score / 4,
              evidenceLevel: 'derived' as const,
            }
          }),
        retrieval,
      )
    },
  }
}
