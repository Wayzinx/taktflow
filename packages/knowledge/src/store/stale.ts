import {
  readJsonFile,
  writeFileAtomic,
  type KnowledgeBase,
  type ProjectStores,
} from '@taktflow/core'
import { rm } from 'node:fs/promises'
import { safeKey, safePath } from './files.js'

async function staleFile(stores: ProjectStores, id: string): Promise<string> {
  return safePath(stores.taktDir, `knowledge/${safeKey(id)}/stale.json`)
}
export async function readStaleSince(stores: ProjectStores, base: KnowledgeBase): Promise<string> {
  const marker = await readJsonFile<{ since: string; version: number }>(
    await staleFile(stores, base.id),
  )
  return marker?.version === base.version ? marker.since : base.updatedAt
}
export async function trackStale(
  stores: ProjectStores,
  base: KnowledgeBase,
  previous?: KnowledgeBase,
): Promise<void> {
  const file = await staleFile(stores, base.id)
  if (base.status === 'ready') {
    await rm(file, { force: true })
    return
  }
  if (base.status !== 'stale') return
  const existing = await readJsonFile<{ since: string; version: number }>(file)
  if (existing?.version === base.version) return
  // 处于 stale 时编辑配置或重新构建不应重置过期时长；升级前的数据以 updatedAt 为起点。
  const since = previous?.status === 'stale' ? previous.updatedAt : base.updatedAt
  await writeFileAtomic(file, JSON.stringify({ since, version: base.version }))
}
