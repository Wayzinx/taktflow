import { readdir, readFile, readlink } from 'node:fs/promises'
import { join } from 'node:path'
import { canonicalJson, sha256 } from './hash.js'

export async function skillContentHash(dir: string): Promise<string> {
  const parts: unknown[] = []
  for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name === '.takt-skill') continue
    const path = join(dir, entry.name)
    parts.push([entry.name, entry.isDirectory() ? 'dir' : entry.isSymbolicLink() ? 'link' : 'file',
      entry.isDirectory() ? await skillContentHash(path) : entry.isSymbolicLink() ? await readlink(path) : sha256(await readFile(path))])
  }
  return sha256(canonicalJson(parts))
}

