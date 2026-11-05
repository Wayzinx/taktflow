import { lstat, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { ToolPaths } from './paths.js'
import { checkAbort } from './abort.js'

export async function linuxBashArgs(paths: ToolPaths): Promise<string[]> {
  const mounts = new Set<string>()
  // 只有完整子树能安全映射成目录 bind；文件 glob 只绑定已存在的匹配文件。
  for (const pattern of paths.scope) {
    const subtree = pattern === '**' ? '' : pattern.endsWith('/**') ? pattern.slice(0, -3) : undefined
    if (subtree === undefined || /[*?]/.test(subtree)) continue
    const path = subtree ? await paths.resolve(subtree) : paths.root
    try {
      if ((await lstat(path)).isDirectory()) mounts.add(path)
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  }
  async function visit(dir: string): Promise<void> {
    checkAbort(paths.signal)
    if (mounts.has(dir)) return
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) await visit(path)
      else if (entry.isFile() && paths.allows(paths.relative(path))) mounts.add(path)
    }
  }
  await visit(paths.root)
  const args = ['--die-with-parent', '--new-session', '--unshare-pid', '--unshare-net', '--cap-drop', 'ALL', '--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc', '--tmpfs', '/tmp']
  // cwd 可能位于 /tmp，先恢复只读树，再覆盖可写白名单。
  args.push('--ro-bind', paths.root, paths.root)
  for (const path of mounts) args.push('--bind', path, path)
  args.push('--clearenv', '--setenv', 'PATH', '/usr/bin:/bin', '--setenv', 'HOME', paths.root,
    '--setenv', 'TMPDIR', '/tmp', '--setenv', 'LANG', 'C', '--setenv', 'LC_ALL', 'C', '--chdir', paths.root)
  return args
}
