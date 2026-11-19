import { assertNoSymlinks, sha256 } from '@taktflow/core'
import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, rename, rm } from 'node:fs/promises'
import { dirname, join, parse, resolve, sep } from 'node:path'
import { spaceLock } from './space-lock.js'

export function storagePath(path: string): string {
  const absolute = resolve(path)
  return process.platform === 'darwin' && /^\/(?:var|tmp)(?:\/|$)/.test(absolute) ? `/private${absolute}` : absolute
}

export const missingFile = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT'

export function checkTeamPath(file: string): Promise<void> {
  return assertNoSymlinks(parse(file).root, file)
}

export async function teamFileLock<T>(file: string, fn: () => Promise<T>): Promise<T> {
  await checkTeamPath(file)
  const parts = file.split(sep)
  const takt = parts.lastIndexOf('.takt')
  const lock = takt >= 0 ? join(parts.slice(0, takt + 1).join(sep), 'runs', '.locks', `${sha256(file)}.lock`) : `${file}.lock`
  await checkTeamPath(lock)
  const info = await lstat(lock).catch(error => { if (!missingFile(error)) throw error })
  if (info && (!info.isFile() || info.nlink !== 1)) throw new Error('Team Hub 锁必须是普通文件')
  return spaceLock(file, async () => {
    await checkTeamPath(file)
    return fn()
  })
}

export async function writeTeamJson(path: string, value: unknown): Promise<void> {
  await checkTeamPath(path)
  const root = dirname(path)
  const tmp = join(root, `${randomUUID()}.tmp`)
  const file = await open(tmp, 'wx', 0o600)
  try {
    try {
      await file.writeFile(JSON.stringify(value))
      await file.sync()
    } finally { await file.close() }
    await rename(tmp, path)
    const dir = await open(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
    try { await dir.sync() } finally { await dir.close() }
  } finally { await rm(tmp, { force: true }) }
}
