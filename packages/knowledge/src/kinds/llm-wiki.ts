import { readSource } from './source-reader.js'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { dirname, join } from 'node:path'
import { mkdir, readFile } from 'node:fs/promises'
import { listFiles, parseFrontmatter, sha256, type KnowledgeKind } from '@taktflow/core'
import { safePath, repositoryPath } from '../store/files.js'
import { bm25, loadIndex, makeIndex, saveIndex, splitChunks, trimHits } from './search.js'
import { generateWiki, type WikiRuntime } from './wiki-run.js'
const execute = promisify(execFile)
export function createWikiKind(runtime?: WikiRuntime): KnowledgeKind {
  return {
    kind: 'llm-wiki', title: 'LLM Wiki', summary: '模块职责、业务流程和设计原因', intents: ['business', 'history', 'impact'], needsBuild: true,
    configSchema: { type: 'object', properties: { source: { type: 'string', enum: ['space', 'path', 'git'] }, path: { type: 'string' }, url: { type: 'string' }, branch: { type: 'string' }, generate: { type: 'object', required: ['repo'], properties: { repo: { type: 'string' }, granularity: { type: 'string', enum: ['directory', 'module'] } } } } },
    async test(kb, ctx) {
      if (kb.config.generate) {
        const root = await repositoryPath(ctx.stores, String((kb.config.generate as { repo: string }).repo))
        const files = await listFiles(root, (kb.config.generate as { include?: string[] }).include ?? ['**'])
        return { ok: files.length > 0, message: '仓库可读；构建需要 wiki-writer、reviewer 和可用 harness，完成后人工发布', preview: files.slice(0, 5).map(f => ({ title: f, ref: f, snippet: f })) }
      }
      const path = kb.config.source === 'path' ? await safePath(ctx.stores.projectDir, String(kb.config.path ?? '.')) : await safePath(ctx.baseDir, 'content')
      if (kb.config.source === 'git') return { ok: /^https?:\/\//.test(String(kb.config.url)), message: '构建时检出 Git，请确认网络策略和仓库地址' }
      const files = await listFiles(path, ['**/*.md'])
      return { ok: files.length > 0, message: `发现 ${files.length} 个 Wiki 页面`, preview: files.slice(0, 5).map(f => ({ ref: f, title: f, snippet: f })) }
    },
    async build(kb, ctx, progress) {
      let root = await safePath(ctx.baseDir, 'content')
      if (kb.config.generate) { progress({ stage: 'generate', done: 0, total: 1 }); root = await generateWiki(kb, ctx, runtime); progress({ stage: 'generate', done: 1, total: 1 }) }
      else if (kb.config.source === 'path') root = await safePath(ctx.stores.projectDir, String(kb.config.path ?? '.'))
      else if (kb.config.source === 'git') {
        if (ctx.stores.config.sandbox?.network === 'none') throw new Error('空间禁止网络访问，请修改策略后重试')
        const url = String(kb.config.url), branch = String(kb.config.branch ?? 'main')
        if (!/^https?:\/\//.test(url) || new URL(url).username || new URL(url).password || branch.startsWith('-') || /[\s~^:?*\[\\]/.test(branch)) throw new Error('Git 地址或分支不合法，请检查配置')
        root = await safePath(dirname(ctx.indexDir), 'repo')
        await mkdir(dirname(root), { recursive: true })
        try { await execute('git', ['-C', root, 'fetch', '--depth=1', 'origin', branch], { signal: ctx.signal, timeout: 60000 }) }
        catch { await execute('git', ['clone', '--depth=1', '--branch', branch, '--', url, root], { signal: ctx.signal, timeout: 60000 }) }
        await execute('git', ['-C', root, 'checkout', '--detach', 'FETCH_HEAD'], { signal: ctx.signal, timeout: 60000 }).catch(async () => { await execute('git', ['-C', root, 'checkout', '--detach', 'HEAD'], { signal: ctx.signal }) })
      }
      const files = await listFiles(root, ['**/*.md']), chunks = [], manifest = []
      const navigation = await readFile(await safePath(root, 'index.md'), 'utf8').catch(() => '')
      for (const file of files) {
        ctx.signal?.throwIfAborted()
        const path = await safePath(root, file), raw = await readSource(path, ctx), parsed = parseFrontmatter(raw)
        const title = String(parsed.data.title ?? /^#\s+(.+)$/m.exec(parsed.body)?.[1] ?? file)
        const aliases = Array.isArray(parsed.data.aliases) ? parsed.data.aliases.map(String) : []
        for (const link of navigation.matchAll(/\[([^\]]+)\]\(([^)#]+)(?:#[^)]*)?\)/g)) if (link[2]?.replace(/^\.\//, '') === file) aliases.push(link[1]!)
        const page = splitChunks(parsed.body, file, title)
        page.forEach((c, i) => { const heading = c.title.split(' / ').at(-1)!; c.ref = `${file}#${heading.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '')}${i ? `-${i}` : ''}` })
        chunks.push(...page.map(c => ({ ...c, aliases, source: path }))); manifest.push({ path, hash: sha256(raw) })
      }
      const index = makeIndex(chunks); index.manifest = manifest; await saveIndex(ctx.indexDir, index)
      progress({ stage: 'index', done: files.length, total: files.length })
      return { stats: { docs: files.length, pages: files.length, chunks: chunks.length, bytes: chunks.reduce((s, c) => s + Buffer.byteLength(c.content), 0) } }
    },
    async query(kb, q, ctx, retrieval) {
      const index = await loadIndex(ctx.indexDir), scores = new Map(bm25(index, q.text).map(r => [r.i, r.score / (1 + r.score)])), query = q.text.toLowerCase()
      index.chunks.forEach((c, i) => { const names = [c.title.split(' / ')[0]!, ...(c.aliases ?? [])].map(s => s.toLowerCase()); const boost = names.includes(query) ? 3 : names.some(s => s.includes(query) || query.includes(s)) ? 2 : 0; if (boost) scores.set(i, boost + (scores.get(i) ?? 0)) })
      return trimHits([...scores].sort((a, b) => b[1] - a[1]).map(([i, score]) => { const c = index.chunks[i]!; return { sourceId: kb.id, ref: c.ref, title: c.title, snippet: c.content, content: c.content, score: score / 4, evidenceLevel: 'derived' as const } }), retrieval)
    },
  }
}
