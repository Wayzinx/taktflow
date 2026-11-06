import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { ProjectStores } from '../interfaces.js'
import type { EvalTarget } from '../types.js'
import { assertNoSymlinks, isEnoent, readJsonFile, toJsonText, writeFileAtomic } from '../store/fs-utils.js'
import { sha256 } from '../util/hash.js'

export const evalRoot = (stores: ProjectStores): string => stores.paths.evals ?? join(stores.taktDir, 'evals')
export function targetName(target: EvalTarget): string {
  if (target.kind === 'skill' && target.name?.trim()) return `skill:${target.name}`
  if (target.kind === 'node' && target.workflowId?.trim() && target.nodeId?.trim()) return `node:${target.workflowId}/${target.nodeId}`
  throw new Error('评测 target 不合法')
}
export function parseEvalTarget(value: string): EvalTarget {
  if (value.startsWith('skill:') && value.length > 6) return { kind: 'skill', name: value.slice(6) }
  const match = /^node:([^/]+)\/(.+)$/.exec(value)
  if (match) return { kind: 'node', workflowId: match[1]!, nodeId: match[2]! }
  throw new Error('target 必须为 node:<workflow>/<node> 或 skill:<name>')
}
export const targetSlug = (target: EvalTarget): string => `${targetName(target).replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 80)}-${sha256(targetName(target)).slice(0, 8)}`
export function evalId(id: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,159}$/.test(id)) throw new Error(`非法评测 id：${id}`)
  return id
}
export async function jsonWrite(root: string, path: string, value: unknown): Promise<void> {
  await assertNoSymlinks(root, path)
  await writeFileAtomic(path, toJsonText(value))
}
export async function jsonFiles<T>(root: string): Promise<T[]> {
  let entries
  await assertNoSymlinks(root, root)
  try { entries = await readdir(root, { withFileTypes: true }) } catch (error) { if (isEnoent(error)) return []; throw error }
  const result: T[] = []
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue
    const file = join(root, entry.name)
    await assertNoSymlinks(root, file)
    const value = await readJsonFile<T>(file)
    if (value !== undefined) result.push(value)
  }
  return result
}
