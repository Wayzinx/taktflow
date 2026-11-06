import { chmod, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'

/** 测试临时空间包含正式的只读快照，清理前只恢复目录权限，不跟随符号链接。 */
export async function removeTestProject(root: string): Promise<void> {
  async function writable(dir: string): Promise<void> {
    await chmod(dir, 0o755)
    for (const entry of await readdir(dir, { withFileTypes: true })) if (entry.isDirectory()) await writable(join(dir, entry.name))
  }
  await writable(root)
  await rm(root, { recursive: true, force: true })
}
