import { cp, lstat, mkdir, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { withLock } from '@taktflow/core'

export interface SyncedSkill { name: string; source: string; target: string }

export async function syncSkills(options: { skillsDir: string; targetRoot: string; harness: string }): Promise<SyncedSkill[]> {
  let entries
  try { entries = await readdir(options.skillsDir, { withFileTypes: true }) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  const root = join(options.targetRoot, options.harness === 'claude-code' ? '.claude' : '.agents', 'skills')
  await mkdir(root, { recursive: true })
  return withLock(root, async () => {
    const synced: SyncedSkill[] = []
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isDirectory()) continue
      const source = join(options.skillsDir, entry.name)
      const target = join(root, entry.name)
      try { await lstat(target); continue } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
      await cp(source, target, { recursive: true, force: false, errorOnExist: true })
      synced.push({ name: entry.name, source, target })
    }
    return synced
  })
}
