import { randomBytes } from 'node:crypto'
import { chmod, lstat, mkdir, readdir, readFile, rename, rm, rmdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { sha256 } from '../util/hash.js'
import { assertNoSymlinks, isEnoent } from './fs-utils.js'
import { assertArtifactPath } from './paths.js'

export async function verifyReadonlyFiles(dir: string, manifest: Record<string, string>): Promise<void> {
  const remaining = new Set(Object.keys(manifest))
  async function visit(relative: string): Promise<void> {
    const file = path.join(dir, relative)
    const info = await lstat(file)
    if (info.isSymbolicLink()) throw new Error(`只读快照不能包含符号链接：${file}`)
    if (info.isDirectory()) {
      for (const entry of await readdir(file)) await visit(relative ? `${relative}/${entry}` : entry)
    } else {
      // 只冻结文件：目录保持可写，否则用户删项目、测试清理都会因权限失败；额外文件由清单校验发现。
      if (info.mode & 0o222) throw new Error(`快照文件不是只读：${file}`)
      if (!info.isFile() || !remaining.delete(relative) || sha256(await readFile(file)) !== manifest[relative]) {
        throw new Error(`快照 hash 校验失败或存在额外文件：${file}`)
      }
    }
  }
  await visit('')
  if (remaining.size) throw new Error(`快照缺少文件：${[...remaining].join(', ')}`)
}

/** 先完成整个目录再发布；现有目录只能完全一致，禁止改写已冻结的材料。 */
export async function materializeReadonlyFiles(dir: string, files: Map<string, Buffer>): Promise<Record<string, string>> {
  const manifest = Object.fromEntries([...files].map(([file, content]) => [assertArtifactPath(file), sha256(content)]))
  const target = path.resolve(dir)
  let emptyTarget = false
  await assertNoSymlinks(path.dirname(target), target)
  try {
    const info = await lstat(target)
    if (!info.isDirectory()) throw new Error(`快照目标不是目录：${target}`)
    if ((await readdir(target)).length) {
      await verifyReadonlyFiles(target, manifest)
      return manifest
    }
    emptyTarget = true
  } catch (error) { if (!isEnoent(error)) throw error }
  const stage = `${target}.${randomBytes(8).toString('hex')}.tmp`
  const dirs = new Set([stage])
  try {
    await mkdir(stage, { recursive: true })
    for (const [relative, content] of files) {
      const file = path.join(stage, relative)
      let parent = path.dirname(file)
      while (parent !== stage) { dirs.add(parent); parent = path.dirname(parent) }
      await mkdir(path.dirname(file), { recursive: true })
      await writeFile(file, content, { flag: 'wx', mode: 0o444 })
    }
    await verifyReadonlyFiles(stage, manifest)
    // rename 不能覆盖已存在的空目录；rmdir 只会移除仍为空的目标。
    if (emptyTarget) await rmdir(target).catch((error: unknown) => { if (!isEnoent(error)) throw error })
    try { await rename(stage, target) } catch (error) {
      if (!['EEXIST', 'ENOTEMPTY'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error
      await verifyReadonlyFiles(target, manifest)
    }
    await verifyReadonlyFiles(target, manifest)
    return manifest
  } finally {
    // 未发布的半成品恢复目录写权限后清理；已发布目录不做 chmod。
    for (const directory of [...dirs].sort((a, b) => a.length - b.length)) {
      await chmod(directory, 0o755).catch((error: unknown) => { if (!isEnoent(error)) throw error })
    }
    await rm(stage, { recursive: true, force: true })
  }
}
