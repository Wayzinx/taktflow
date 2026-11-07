import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import {
  sha256,
  estimateTokens,
  readJsonFile,
  writeFileAtomic,
  type KnowledgeHit,
  type KnowledgeRetrieval,
} from '@taktflow/core'
export interface Chunk {
  ref: string
  title: string
  content: string
  hash: string
  source?: string
  aliases?: string[]
}
export interface Index {
  chunks: Chunk[]
  terms: Record<string, Array<[number, number]>>
  lengths: number[]
  dimensions?: number
  embeddingKey?: string
  manifest?: Array<{ path: string; hash: string }>
}
export function tokenize(text: string): string[] {
  const out: string[] = text.toLowerCase().match(/[a-z0-9_]+/g) ?? []
  for (const run of text.match(/[\p{Script=Han}]+/gu) ?? []) {
    if (run.length === 1) out.push(run)
    for (let index2 = 0; index2 < run.length - 1; index2++) out.push(run.slice(index2, index2 + 2))
  }
  return out
}
export function makeIndex(chunks: Chunk[]): Index {
  const terms: Index['terms'] = Object.create(null)
  const lengths: number[] = []
  chunks.forEach((chunk, index3) => {
    const words = tokenize(`${chunk.title} ${chunk.content}`)
    const counts = new Map<string, number>()
    lengths.push(words.length)
    for (const word of words) counts.set(word, (counts.get(word) ?? 0) + 1)
    for (const [word, count] of counts) (terms[word] ??= []).push([index3, count])
  })
  return { chunks, terms, lengths }
}
export function bm25(index: Index, query: string): Array<{ i: number; score: number }> {
  const count2 = index.chunks.length
  const avg = index.lengths.reduce((left2, right2) => left2 + right2, 0) / (count2 || 1) || 1
  const scores = new Map<number, number>()
  for (const term of new Set(tokenize(query))) {
    const postings = Object.hasOwn(index.terms, term) ? index.terms[term]! : []
    const idf = Math.log(1 + (count2 - postings.length + 0.5) / (postings.length + 0.5))
    for (const [index4, tf] of postings)
      scores.set(
        index4,
        (scores.get(index4) ?? 0) +
          (idf * tf * 2.2) / (tf + 1.2 * (0.25 + (0.75 * index.lengths[index4]!) / avg)),
      )
  }
  return [...scores]
    .map(([index5, score]) => ({ i: index5, score }))
    .sort((left3, right3) => right3.score - left3.score)
    .slice(0, 50)
}
export function splitChunks(
  text: string,
  ref: string,
  title: string,
  size = 800,
  overlap = 100,
): Chunk[] {
  if (!Number.isInteger(size) || size <= 0 || overlap < 0 || overlap >= size)
    throw new Error('切块参数不合法，请确保 size > overlap >= 0')
  const chunks: Chunk[] = []
  const headings: string[] = []
  for (const section of text.split(/(?=^#{1,6}\s)/m)) {
    const heading = /^(#{1,6})\s+(.+)/.exec(section)
    if (heading) {
      headings.length = heading[1]!.length - 1
      headings.push(heading[2]!)
    }
    for (let start = 0; start < section.length; start += (size - overlap) * 4) {
      const content = section.slice(start, start + size * 4).trim()
      if (content)
        chunks.push({
          ref: `${ref}#${chunks.length}`,
          title: [title, ...headings].filter(Boolean).join(' / '),
          content,
          hash: sha256(content),
        })
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
export const saveIndex = (dir: string, index: Index) =>
  writeFileAtomic(join(dir, 'index/index.json'), JSON.stringify(index))
const vectorCache = new Map<string, { signature: string; vectors: Float32Array[]; bytes: number }>()
export async function loadVectors(dir: string, index: Index): Promise<Float32Array[]> {
  if (!index.dimensions) return []
  const file = join(dir, 'index/vectors.f32')
  const info = await stat(file)
  const signature = `${info.mtimeMs}:${info.ctimeMs}:${info.size}:${index.dimensions}:${index.chunks.length}`
  const cached = vectorCache.get(file)
  if (cached?.signature === signature) return cached.vectors
  const buffer = await readFile(file)
  if (buffer.length !== index.chunks.length * index.dimensions * 4)
    throw new Error('向量文件大小不匹配，请重新构建')
  const values = new Float32Array(
    buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength),
  )
  const vectors = index.chunks.map((_, offset) =>
    values.subarray(offset * index.dimensions!, (offset + 1) * index.dimensions!),
  )
  vectorCache.delete(file)
  while (
    vectorCache.size &&
    (vectorCache.size >= 2 ||
      [...vectorCache.values()].reduce((total, entry) => total + entry.bytes, buffer.length) >
        512 * 1024 * 1024)
  ) {
    vectorCache.delete(vectorCache.keys().next().value!)
  }
  vectorCache.set(file, { signature, vectors, bytes: buffer.length })
  return vectors
}
export function cosine(left: ArrayLike<number>, right: ArrayLike<number>): number {
  if (left.length !== right.length) throw new Error('嵌入维度改变，请重新构建知识库')
  let dot = 0
  let leftNorm = 0
  let rightNorm = 0
  for (let index = 0; index < left.length; index++) {
    dot += left[index]! * right[index]!
    leftNorm += left[index]! ** 2
    rightNorm += right[index]! ** 2
  }
  return leftNorm && rightNorm ? dot / Math.sqrt(leftNorm * rightNorm) : 0
}
export function trimHits(hits: KnowledgeHit[], retrieval: KnowledgeRetrieval): KnowledgeHit[] {
  let remaining = retrieval.budgetTokens
  const selected: KnowledgeHit[] = []
  for (const hit of hits
    .filter((hit2) => (hit2.score ?? 0) >= (retrieval.minScore ?? 0))
    .slice(0, retrieval.topK)) {
    if (remaining <= 0) break
    const snippet =
      estimateTokens(hit.snippet) > remaining ? hit.snippet.slice(0, remaining * 4) : hit.snippet
    selected.push({ ...hit, snippet, rank: selected.length + 1 })
    remaining -= estimateTokens(snippet)
  }
  return selected
}
