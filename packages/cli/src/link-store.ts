import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, open, realpath, rename, unlink } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { UsageError } from './args.js'
import { record, validToken } from './team-transport.js'
import { inside } from './worker-harness.js'

const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT'
const unsafe = () => new Error('链接凭据存储不安全；目录必须归当前用户所有且权限为 0700，文件权限为 0600，不允许链接')

async function canonicalAncestor(path: string): Promise<string> {
  try { return await realpath(path) } catch (error) {
    if (!missing(error) || dirname(path) === path) throw error
    return join(await canonicalAncestor(dirname(path)), basename(path))
  }
}

async function ensureDirectory(path: string, uid: number, privateDir: boolean): Promise<void> {
  const parent = dirname(path)
  if (parent !== path) await ensureDirectory(parent, uid, false)
  const info = await lstat(path).catch(async (error: unknown) => {
    if (!missing(error)) throw error
    await mkdir(path, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'EEXIST') throw error
    })
    return lstat(path)
  })
  if (!info.isDirectory()) throw unsafe()
  if (privateDir) {
    if (info.uid !== uid || (info.mode & 0o7777) !== 0o700) throw unsafe()
  } else if ((info.uid !== uid && info.uid !== 0) || ((info.mode & 0o022) !== 0 && (info.mode & 0o1000) === 0)) {
    throw unsafe()
  }
}

async function privateRoot(path: string, checkout: string, uid: number): Promise<string> {
  if (!isAbsolute(path)) throw new UsageError('TAKT_LINK_DIR 必须是绝对路径')
  const absolute = resolve(path)
  let root: string
  try {
    root = join(await canonicalAncestor(dirname(absolute)), basename(absolute))
  } catch { throw new Error('无法解析链接凭据目录') }
  if (inside(checkout, root)) throw new UsageError('链接凭据目录必须位于 --project 之外')
  try { await ensureDirectory(root, uid, true) } catch (error) {
    if ((error as NodeJS.ErrnoException).code) throw new Error('无法访问链接凭据目录')
    throw error
  }
  return root
}

async function loadToken(file: string, key: string, uid: number): Promise<string | undefined> {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch((error: unknown) => {
    if (missing(error)) return undefined
    throw unsafe()
  })
  if (!handle) return undefined
  try {
    const info = await handle.stat()
    if (!info.isFile() || info.uid !== uid || info.nlink !== 1 || (info.mode & 0o7777) !== 0o600) throw unsafe()
    const data = Buffer.alloc(513)
    const { bytesRead } = await handle.read(data)
    const invalid = () => new Error('已保存的链接凭据无效或不属于该目标')
    if (bytesRead === data.length) throw invalid()
    let value: unknown
    try { value = JSON.parse(data.subarray(0, bytesRead).toString('utf8')) } catch { throw invalid() }
    if (!record(value) || value.key !== key || typeof value.token !== 'string' || !validToken(value.token)) throw invalid()
    return value.token
  } finally { await handle.close() }
}

async function saveToken(root: string, file: string, key: string, token: string): Promise<void> {
  const temp = join(root, `.${randomUUID()}.tmp`)
  const handle = await open(temp, 'wx', 0o600)
  try {
    try {
      await handle.chmod(0o600)
      await handle.writeFile(JSON.stringify({ key, token }))
      await handle.sync()
    } finally { await handle.close() }
    await rename(temp, file)
  } finally { await unlink(temp).catch(() => {}) }
}

export async function linkStore(home: string, checkout: string, endpoint: URL) {
  const uid = process.getuid!()
  const root = await privateRoot(process.env.TAKT_LINK_DIR ?? join(home, '.takt-link'), checkout, uid)
  const key = createHash('sha256').update(endpoint.href).digest('hex')
  const file = join(root, `${key}.json`)
  return {
    load: async () => {
      try { return await loadToken(file, key, uid) } catch (error) {
        if ((error as NodeJS.ErrnoException).code) throw new Error('无法读取链接凭据')
        throw error
      }
    },
    save: async (token: string) => {
      try { await saveToken(root, file, key, token) } catch { throw new Error('无法保存链接凭据；请重新获取配对码后重试') }
    },
  }
}
