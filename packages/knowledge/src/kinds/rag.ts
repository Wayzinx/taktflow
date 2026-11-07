import { dirname, join } from 'node:path'
import { sha256, writeFileAtomic, type KnowledgeKind, type KnowledgeHit } from '@taktflow/core'
import { documents } from './documents.js'
import {
  bm25,
  cosine,
  loadIndex,
  loadVectors,
  makeIndex,
  saveIndex,
  splitChunks,
  trimHits,
} from './search.js'
export const ragKind: KnowledgeKind = {
  kind: 'rag',
  title: '文档检索',
  summary: '业务规则、产品文档和规范',
  example: '退款规则是什么？',
  intents: ['business', 'fact'],
  needsBuild: true,
  configSchema: {
    type: 'object',
    properties: {
      sources: {
        type: 'array',
        items: {
          type: 'object',
          required: ['type'],
          properties: {
            type: { type: 'string', enum: ['upload', 'path', 'repo', 'url'] },
            path: { type: 'string' },
            repo: { type: 'string' },
            urls: { type: 'array', items: { type: 'string' } },
          },
        },
      },
      chunkTokens: { type: 'integer' },
      overlapTokens: { type: 'integer' },
    },
  },
  async test(kb, ctx) {
    const docs = await documents(kb, ctx)
    return {
      ok: docs.length > 0,
      message: docs.length ? `可读取 ${docs.length} 个文档` : '没有文档，请上传文件或检查数据源',
      preview: docs
        .slice(0, 5)
        .map((document) => ({
          title: document.title,
          ref: document.ref,
          snippet: document.text.slice(0, 300),
        })),
    }
  },
  async build(kb, ctx, progress) {
    progress({ stage: 'parse', done: 0, total: 1 })
    const docs = await documents(kb, ctx)
    progress({ stage: 'parse', done: docs.length, total: docs.length })
    const chunks = docs.flatMap((document2) =>
      splitChunks(
        document2.text,
        document2.ref,
        document2.title,
        Number(kb.config.chunkTokens ?? 800),
        Number(kb.config.overlapTokens ?? 100),
      ).map((chunk2) => ({ ...chunk2, source: document2.path, aliases: document2.aliases })),
    )
    const index = makeIndex(chunks)
    const modelId = ctx.stores.config.knowledgeDefaults?.embeddingModel
    index.embeddingKey = sha256(
      JSON.stringify(modelId ? ctx.stores.config.models?.[modelId] : 'custom'),
    )
    index.manifest = docs
      .filter((document3) => document3.path)
      .map((document4) => ({ path: document4.path!, hash: document4.hash }))
    progress({ stage: 'chunk', done: chunks.length, total: chunks.length })
    if (ctx.embed && chunks.length) {
      const oldVersion = kb.candidateVersion ?? kb.version
      const oldDir = join(dirname(ctx.indexDir), `v${oldVersion}`)
      const cache = new Map<string, number[] | Float32Array>()
      if (oldVersion) {
        const old = await loadIndex(oldDir).catch(() => undefined)
        if (old?.dimensions && old.embeddingKey === index.embeddingKey) {
          const vectors = await loadVectors(oldDir, old)
          old.chunks.forEach((chunk3, index2) => cache.set(chunk3.hash, vectors[index2]!))
        }
      }
      const missing = [
        ...new Map(
          chunks.filter((chunk4) => !cache.has(chunk4.hash)).map((chunk5) => [chunk5.hash, chunk5]),
        ).values(),
      ]
      for (let index3 = 0; index3 < missing.length; index3 += 64) {
        ctx.signal?.throwIfAborted()
        const batch = missing.slice(index3, index3 + 64)
        const vectors = await ctx.embed(batch.map((chunk6) => chunk6.content))
        if (vectors.length !== batch.length) throw new Error('嵌入数量不匹配，请检查模型配置')
        batch.forEach((chunk7, offset) => cache.set(chunk7.hash, vectors[offset]!))
        progress({
          stage: 'embed',
          done: Math.min(index3 + 64, missing.length),
          total: missing.length,
        })
      }
      const vectors = chunks.map((chunk8) => cache.get(chunk8.hash)!)
      const dimensions = vectors[0]!.length
      if (
        !dimensions ||
        vectors.some(
          (value) => value.length !== dimensions || value.some((count) => !Number.isFinite(count)),
        )
      )
        throw new Error('嵌入向量无效，请检查模型维度并重建')
      index.dimensions = dimensions
      const buffer = Buffer.alloc(vectors.length * dimensions * 4)
      vectors.forEach((value2, index4) =>
        value2.forEach((count2, offset2) =>
          buffer.writeFloatLE(count2, (index4 * dimensions + offset2) * 4),
        ),
      )
      await writeFileAtomic(join(ctx.indexDir, 'index/vectors.f32'), buffer)
    }
    ctx.signal?.throwIfAborted()
    await saveIndex(ctx.indexDir, index)
    progress({
      stage: 'index',
      done: chunks.length,
      total: chunks.length,
      log: index.dimensions ? '混合检索索引已构建' : '未配置嵌入模型，使用 BM25',
    })
    return {
      stats: {
        docs: docs.length,
        chunks: chunks.length,
        bytes: docs.reduce((total2, document5) => total2 + Buffer.byteLength(document5.text), 0),
      },
    }
  },
  async query(kb, query2, ctx, retrieval) {
    const index = await loadIndex(ctx.indexDir)
    const lexical = bm25(index, query2.text)
    const modelId = ctx.stores.config.knowledgeDefaults?.embeddingModel
    if (
      ctx.embed &&
      index.dimensions &&
      index.embeddingKey !==
        sha256(JSON.stringify(modelId ? ctx.stores.config.models?.[modelId] : 'custom'))
    )
      throw new Error('嵌入模型已改变，请重新构建后查询')
    const vectors = ctx.embed && index.dimensions ? await loadVectors(ctx.indexDir, index) : []
    const embedding = vectors.length ? (await ctx.embed!([query2.text]))[0]! : []
    const semantic = vectors
      .map((value3, index5) => ({ i: index5, score: cosine(value3, embedding) }))
      .filter((value4) => value4.score > 0)
      .sort((left, right) => right.score - left.score)
      .slice(0, 50)
    const weights = retrieval.hybrid ?? { bm25: 1, vector: 1 }
    const merged = new Map<number, { rrf: number; bm25?: number; vector?: number }>()
    for (const [name, list, weight] of [
      ['bm25', lexical, weights.bm25],
      ['vector', semantic, vectors.length ? weights.vector : 0],
    ] as const) {
      if (weight <= 0) continue
      const max = list[0]?.score ?? 1
      list.forEach((value5, rank) => {
        const scores = merged.get(value5.i) ?? { rrf: 0 }
        scores.rrf += weight / (61 + rank)
        scores[name] = value5.score / max
        merged.set(value5.i, scores)
      })
    }
    const denominator = (weights.bm25 + (vectors.length ? weights.vector : 0)) / 61 || 1
    const hits = [...merged]
      .sort((left2, right2) => right2[1].rrf - left2[1].rrf)
      .map(([index6, scores]): KnowledgeHit => {
        const chunk = index.chunks[index6]!
        return {
          sourceId: kb.id,
          ref: chunk.ref,
          title: chunk.title,
          snippet: chunk.content,
          content: chunk.content,
          score: scores.rrf / denominator,
          scores,
          evidenceLevel: 'derived',
        }
      })
    return trimHits(hits, retrieval)
  },
}
