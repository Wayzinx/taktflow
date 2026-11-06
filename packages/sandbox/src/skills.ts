import { cp, lstat, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { skillContentHash, withLock } from '@taktflow/core'

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
      const hash = await skillContentHash(source)
      try {
        if (!(await lstat(target)).isDirectory()) continue
        let previous: string
        try { previous = await readFile(join(target, '.takt-skill'), 'utf8') } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            // 旧同步副本无标记；仅认领内容一致的副本，保留无法证明来源的用户文件。
            if (await skillContentHash(target) !== hash) continue
            await writeFile(join(target, '.takt-skill'), hash)
            continue
          }
          throw error
        }
        if (previous === hash) continue
        await rm(target, { recursive: true })
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
      await cp(source, target, { recursive: true, force: false, errorOnExist: true })
      await writeFile(join(target, '.takt-skill'), hash)
      synced.push({ name: entry.name, source, target })
    }
    return synced
  })
}
