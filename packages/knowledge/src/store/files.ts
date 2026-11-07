import { join, resolve, relative, isAbsolute } from 'node:path'
import { readdir } from 'node:fs/promises'
import { assertNoSymlinks } from '@taktflow/core'
export function safeKey(id: string): string {
  if (typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(id))
    throw new Error('知识库 ID 不合法，请使用字母、数字、下划线或短横线')
  return id
}
export async function safePath(root: string, path: string): Promise<string> {
  if (
    typeof path !== 'string' ||
    path.includes('\\') ||
    path.includes('\0') ||
    isAbsolute(path) ||
    path.split('/').includes('..')
  )
    throw new Error('路径不合法，请使用目录内的相对路径')
  const full = resolve(root, path)
  const rel = relative(root, full)
  if (rel === '..' || rel.startsWith('../')) throw new Error('路径越界，请选择目录内文件')
  await assertNoSymlinks(root, full)
  return full
}
export async function entries(path: string): Promise<string[]> {
  try {
    return await readdir(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}
export const jsonPath = (root: string, id: string) => join(root, `${safeKey(id)}.json`)

export async function repositoryPath(
  stores: import('@taktflow/core').ProjectStores,
  id: string,
): Promise<string> {
  const repo = stores.config.repos?.find((record) => record.id === id)
  if (!repo) throw new Error('仓库未绑定，请先在空间中绑定仓库')
  if (repo.url) return safePath(stores.taktDir, `repos/${safeKey(id)}`)
  const root = resolve(stores.projectDir, repo.path)
  await assertNoSymlinks(root, root)
  return root
}
