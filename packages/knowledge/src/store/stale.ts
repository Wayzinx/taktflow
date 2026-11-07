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
    await clearSourceStale(stores, base.id)
    return
  }
  if (base.status !== 'stale') return
  const existing = await readJsonFile<{ since: string; version: number }>(file)
  if (existing?.version === base.version) return
  // 处于 stale 时编辑配置或重新构建不应重置过期时长；升级前的数据以 updatedAt 为起点。
  const since = previous?.status === 'stale' ? previous.updatedAt : base.updatedAt
  await writeFileAtomic(file, JSON.stringify({ since, version: base.version }))
}

/**
 * "过期"是否只因为来源文件变了（而不是改了配置或上传了新文件）。只有这种情况下来源恢复原样时才能自动回到 ready；
 * 改配置、上传都会清掉这个标记，必须重新构建。
 */
async function sourceStaleFile(stores: ProjectStores, id: string): Promise<string> {
  return safePath(stores.taktDir, `knowledge/${safeKey(id)}/source-stale.json`)
}
export async function markSourceStale(stores: ProjectStores, id: string): Promise<void> {
  await writeFileAtomic(await sourceStaleFile(stores, id), JSON.stringify({ at: new Date().toISOString() }))
}
export async function isSourceStale(stores: ProjectStores, id: string): Promise<boolean> {
  return Boolean(await readJsonFile(await sourceStaleFile(stores, id)))
}
export async function clearSourceStale(stores: ProjectStores, id: string): Promise<void> {
  await rm(await sourceStaleFile(stores, id), { force: true })
}
