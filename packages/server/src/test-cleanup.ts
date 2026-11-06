import { chmod, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'

export async function removeTestProject(root: string): Promise<void> {
  async function writable(dir: string): Promise<void> {
    await chmod(dir, 0o755)
    for (const entry of await readdir(dir, { withFileTypes: true })) if (entry.isDirectory()) await writable(join(dir, entry.name))
  }
  await writable(root)
  await rm(root, { recursive: true, force: true })
}
