import { cp, lstat, mkdir, readdir, readFile, readlink, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { sha256, withLock } from '@taktflow/core'

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
      const hash = await skillHash(source)
      try {
        if (!(await lstat(target)).isDirectory()) continue
        let previous: string
        try { previous = await readFile(join(target, '.takt-skill'), 'utf8') } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
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

async function skillHash(dir: string): Promise<string> {
  const entries = await readdir(dir, { withFileTypes: true })
  const parts: string[] = []
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name === '.takt-skill') continue
    const path = join(dir, entry.name)
    const content = entry.isDirectory() ? await skillHash(path)
      : entry.isSymbolicLink() ? await readlink(path) : sha256(await readFile(path))
    parts.push(JSON.stringify([entry.name, entry.isDirectory() ? 'dir' : entry.isSymbolicLink() ? 'link' : 'file', content]))
  }
  return sha256(parts.join('\n'))
}
