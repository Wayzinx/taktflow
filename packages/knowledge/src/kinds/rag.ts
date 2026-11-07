import { dirname, join } from 'node:path'
import { sha256, writeFileAtomic, type KnowledgeKind, type KnowledgeHit } from '@taktflow/core'
import { documents } from './documents.js'
import { bm25, cosine, loadIndex, loadVectors, makeIndex, saveIndex, splitChunks, trimHits } from './search.js'
export const ragKind: KnowledgeKind = {
  kind: 'rag', title: '文档检索', summary: '业务规则、产品文档和规范', example: '退款规则是什么？', intents: ['business', 'fact'], needsBuild: true,
  configSchema: { type: 'object', properties: { sources: { type: 'array', items: { type: 'object', required: ['type'], properties: { type: { type: 'string', enum: ['upload', 'path', 'repo', 'url'] }, path: { type: 'string' }, repo: { type: 'string' }, urls: { type: 'array', items: { type: 'string' } } } } }, chunkTokens: { type: 'integer' }, overlapTokens: { type: 'integer' } } },
  async test(kb, ctx) {
    const docs = await documents(kb, ctx)
    return { ok: docs.length > 0, message: docs.length ? `可读取 ${docs.length} 个文档` : '没有文档，请上传文件或检查数据源', preview: docs.slice(0, 5).map(d => ({ title: d.title, ref: d.ref, snippet: d.text.slice(0, 300) })) }
  },
  async build(kb, ctx, progress) {
    progress({ stage: 'parse', done: 0, total: 1 })
    const docs = await documents(kb, ctx)
    progress({ stage: 'parse', done: docs.length, total: docs.length })
    const chunks = docs.flatMap(d => splitChunks(d.text, d.ref, d.title, Number(kb.config.chunkTokens ?? 800), Number(kb.config.overlapTokens ?? 100)).map(c => ({ ...c, source: d.path, aliases: d.aliases })))
    const index = makeIndex(chunks)
    const modelId = ctx.stores.config.knowledgeDefaults?.embeddingModel
    index.embeddingKey = sha256(JSON.stringify(modelId ? ctx.stores.config.models?.[modelId] : 'custom'))
    index.manifest = docs.filter(d => d.path).map(d => ({ path: d.path!, hash: d.hash }))
    progress({ stage: 'chunk', done: chunks.length, total: chunks.length })
    if (ctx.embed && chunks.length) {
      const oldVersion = kb.candidateVersion ?? kb.version, oldDir = join(dirname(ctx.indexDir), `v${oldVersion}`)
      const cache = new Map<string, number[]>()
      if (oldVersion) {
        const old = await loadIndex(oldDir).catch(() => undefined)
        if (old?.dimensions && old.embeddingKey === index.embeddingKey) { const vectors = await loadVectors(oldDir, old); old.chunks.forEach((c, i) => cache.set(c.hash, vectors[i]!)) }
      }
      const missing = [...new Map(chunks.filter(c => !cache.has(c.hash)).map(c => [c.hash, c])).values()]
      for (let i = 0; i < missing.length; i += 64) {
        ctx.signal?.throwIfAborted()
        const batch = missing.slice(i, i + 64), vectors = await ctx.embed(batch.map(c => c.content))
        if (vectors.length !== batch.length) throw new Error('嵌入数量不匹配，请检查模型配置')
        batch.forEach((c, j) => cache.set(c.hash, vectors[j]!))
        progress({ stage: 'embed', done: Math.min(i + 64, missing.length), total: missing.length })
      }
      const vectors = chunks.map(c => cache.get(c.hash)!), dimensions = vectors[0]!.length
      if (!dimensions || vectors.some(v => v.length !== dimensions || v.some(n => !Number.isFinite(n)))) throw new Error('嵌入向量无效，请检查模型维度并重建')
      index.dimensions = dimensions
      const buffer = Buffer.alloc(vectors.length * dimensions * 4)
      vectors.forEach((v, i) => v.forEach((n, j) => buffer.writeFloatLE(n, (i * dimensions + j) * 4)))
      await writeFileAtomic(join(ctx.indexDir, 'index/vectors.f32'), buffer)
    }
    ctx.signal?.throwIfAborted()
    await saveIndex(ctx.indexDir, index)
    progress({ stage: 'index', done: chunks.length, total: chunks.length, log: index.dimensions ? '混合检索索引已构建' : '未配置嵌入模型，使用 BM25' })
    return { stats: { docs: docs.length, chunks: chunks.length, bytes: docs.reduce((s, d) => s + Buffer.byteLength(d.text), 0) } }
  },
  async query(kb, q, ctx, retrieval) {
    const index = await loadIndex(ctx.indexDir), lexical = bm25(index, q.text)
    const modelId = ctx.stores.config.knowledgeDefaults?.embeddingModel
    if (ctx.embed && index.dimensions && index.embeddingKey !== sha256(JSON.stringify(modelId ? ctx.stores.config.models?.[modelId] : 'custom'))) throw new Error('嵌入模型已改变，请重新构建后查询')
    const vectors = ctx.embed && index.dimensions ? await loadVectors(ctx.indexDir, index) : []
    const embedding = vectors.length ? (await ctx.embed!([q.text]))[0]! : []
    const semantic = vectors.map((v, i) => ({ i, score: cosine(v, embedding) })).filter(v => v.score > 0).sort((a, b) => b.score - a.score).slice(0, 50)
    const weights = retrieval.hybrid ?? { bm25: 1, vector: 1 }, merged = new Map<number, { rrf: number; bm25?: number; vector?: number }>()
    for (const [name, list, weight] of [['bm25', lexical, weights.bm25], ['vector', semantic, vectors.length ? weights.vector : 0]] as const) {
      if (weight <= 0) continue
      const max = list[0]?.score ?? 1
      list.forEach((v, rank) => { const scores = merged.get(v.i) ?? { rrf: 0 }; scores.rrf += weight / (61 + rank); scores[name] = v.score / max; merged.set(v.i, scores) })
    }
    const denominator = (weights.bm25 + (vectors.length ? weights.vector : 0)) / 61 || 1
    const hits = [...merged].sort((a, b) => b[1].rrf - a[1].rrf).map(([i, scores]): KnowledgeHit & { content: string } => {
      const chunk = index.chunks[i]!
      return { sourceId: kb.id, ref: chunk.ref, title: chunk.title, snippet: chunk.content, content: chunk.content, score: scores.rrf / denominator, scores, evidenceLevel: 'derived' }
    })
    return trimHits(hits, retrieval)
  },
}
