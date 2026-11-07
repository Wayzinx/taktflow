import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { sha256, estimateTokens, readJsonFile, writeFileAtomic, type KnowledgeHit, type KnowledgeRetrieval } from '@taktflow/core'
export interface Chunk { ref: string; title: string; content: string; hash: string; source?: string; aliases?: string[] }
export interface Index { chunks: Chunk[]; terms: Record<string, Array<[number, number]>>; lengths: number[]; dimensions?: number; embeddingKey?: string; manifest?: Array<{ path: string; hash: string }> }
export function tokenize(text: string): string[] {
  const out: string[] = text.toLowerCase().match(/[a-z0-9_]+/g) ?? []
  for (const run of text.match(/[\p{Script=Han}]+/gu) ?? []) {
    if (run.length === 1) out.push(run)
    for (let i = 0; i < run.length - 1; i++) out.push(run.slice(i, i + 2))
  }
  return out
}
export function makeIndex(chunks: Chunk[]): Index {
  const terms: Index['terms'] = Object.create(null), lengths: number[] = []
  chunks.forEach((chunk, i) => {
    const words = tokenize(`${chunk.title} ${chunk.content}`), counts = new Map<string, number>()
    lengths.push(words.length)
    for (const word of words) counts.set(word, (counts.get(word) ?? 0) + 1)
    for (const [word, count] of counts) (terms[word] ??= []).push([i, count])
  })
  return { chunks, terms, lengths }
}
export function bm25(index: Index, query: string): Array<{ i: number; score: number }> {
  const n = index.chunks.length, avg = index.lengths.reduce((a, b) => a + b, 0) / (n || 1) || 1, scores = new Map<number, number>()
  for (const term of new Set(tokenize(query))) {
    const postings = index.terms[term] ?? [], idf = Math.log(1 + (n - postings.length + 0.5) / (postings.length + 0.5))
    for (const [i, tf] of postings) scores.set(i, (scores.get(i) ?? 0) + idf * tf * 2.2 / (tf + 1.2 * (0.25 + 0.75 * index.lengths[i]! / avg)))
  }
  return [...scores].map(([i, score]) => ({ i, score })).sort((a, b) => b.score - a.score).slice(0, 50)
}
export function splitChunks(text: string, ref: string, title: string, size = 800, overlap = 100): Chunk[] {
  if (!Number.isInteger(size) || size <= 0 || overlap < 0 || overlap >= size) throw new Error('切块参数不合法，请确保 size > overlap >= 0')
  const chunks: Chunk[] = [], headings: string[] = []
  for (const section of text.split(/(?=^#{1,6}\s)/m)) {
    const heading = /^(#{1,6})\s+(.+)/.exec(section)
    if (heading) { headings.length = heading[1]!.length - 1; headings.push(heading[2]!) }
    for (let start = 0; start < section.length; start += (size - overlap) * 4) {
      const content = section.slice(start, start + size * 4).trim()
      if (content) chunks.push({ ref: `${ref}#${chunks.length}`, title: [title, ...headings].filter(Boolean).join(' / '), content, hash: sha256(content) })
      if (start + size * 4 >= section.length) break
    }
  }
  return chunks
}
export async function loadIndex(dir: string): Promise<Index> {
  const index = await readJsonFile<Index>(join(dir, 'index/index.json'))
  if (!index) throw new Error('索引不存在，请先构建知识库')
  return index
}
export const saveIndex = (dir: string, index: Index) => writeFileAtomic(join(dir, 'index/index.json'), JSON.stringify(index))
export async function loadVectors(dir: string, index: Index): Promise<number[][]> {
  if (!index.dimensions) return []
  const buffer = await readFile(join(dir, 'index/vectors.f32'))
  return index.chunks.map((_, i) => Array.from({ length: index.dimensions! }, (__, j) => buffer.readFloatLE((i * index.dimensions! + j) * 4)))
}
export function cosine(a: number[], b: number[]): number {
  if (a.length !== b.length) throw new Error('嵌入维度改变，请重新构建知识库')
  let dot = 0, aa = 0, bb = 0
  a.forEach((v, i) => { dot += v * b[i]!; aa += v * v; bb += b[i]! * b[i]! })
  return aa && bb ? dot / Math.sqrt(aa * bb) : 0
}
export function trimHits(hits: KnowledgeHit[], retrieval: KnowledgeRetrieval): KnowledgeHit[] {
  let remaining = retrieval.budgetTokens
  const selected: KnowledgeHit[] = []
  for (const hit of hits.filter(h => (h.score ?? 0) >= (retrieval.minScore ?? 0)).slice(0, retrieval.topK)) {
    if (remaining <= 0) break
    const snippet = estimateTokens(hit.snippet) > remaining ? hit.snippet.slice(0, remaining * 4) : hit.snippet
    selected.push({ ...hit, snippet, rank: selected.length + 1 })
    remaining -= estimateTokens(snippet)
  }
  return selected
}
