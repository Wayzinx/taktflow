import { lstat, readdir, realpath } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { ProjectStores } from '../interfaces.js'
import type { EvalVariant } from '../types.js'
import { assertNoSymlinks } from '../store/fs-utils.js'

async function checkTree(path: string): Promise<void> {
  const info = await lstat(path)
  if (info.isSymbolicLink()) throw new Error('符号链接不允许作为变体输入')
  if (info.isDirectory()) for (const entry of await readdir(path)) await checkTree(join(path, entry))
  else if (!info.isFile()) throw new Error('变体只支持普通文件和目录')
}

// 外部请求只能引用当前空间中的相对路径；校验在任何读取、复制和模型调用之前完成。
export async function resolveVariantPaths(stores: ProjectStores, variants: EvalVariant[]): Promise<EvalVariant[]> {
  const root = await realpath(stores.projectDir)
  return Promise.all(variants.map(async (variant) => {
    const result = { ...variant }
    for (const field of ['skillsDir', 'promptFile', 'profileFile'] as const) {
      const value = variant[field]
      if (value === undefined) continue
      try {
        if (typeof value !== 'string' || !value || isAbsolute(value) || value.includes('\\') || value.split('/').includes('..')) throw new Error()
        const path = resolve(root, value)
        await assertNoSymlinks(root, path)
        const resolved = await realpath(path), rel = relative(root, resolved)
        if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error()
        const info = await lstat(resolved)
        if (field === 'skillsDir' ? !info.isDirectory() : !info.isFile()) throw new Error()
        await checkTree(resolved)
        result[field] = resolved
      } catch { throw new Error('变体路径无效：必须是当前空间内存在的相对路径，不能包含符号链接') }
    }
    return result
  }))
}
