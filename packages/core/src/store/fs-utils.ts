import { randomBytes } from 'node:crypto'
import { link, lstat, mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'

/** 只有 ENOENT 当作"不存在"，其它错误（权限、损坏）照常抛出。 */
export function isEnoent(err: unknown): boolean {
  return (err as NodeJS.ErrnoException | undefined)?.code === 'ENOENT'
}

export function toJsonText(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`
}

/** 先写同目录临时文件再 rename，读者不会看到半写的文件。 */
export async function writeFileAtomic(file: string, data: Buffer | string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true })
  const tmp = `${file}.${randomBytes(8).toString('hex')}.tmp`
  try {
    await writeFile(tmp, data)
    await rename(tmp, file)
  } catch (err) {
    await rm(tmp, { force: true })
    throw err
  }
}

/** link 的目标排他创建，跨进程初始化也不会覆盖先落盘的配置。 */
export async function writeFileIfAbsent(file: string, data: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true })
  const tmp = `${file}.${randomBytes(8).toString('hex')}.tmp`
  try {
    await writeFile(tmp, data, { flag: 'wx' })
    try {
      await link(tmp, file)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
    }
  } finally {
    await rm(tmp, { force: true })
  }
}

/** 从存储根目录检查每个组件，拒绝已有符号链接把产物访问导向目录外。 */
export async function assertNoSymlinks(root: string, file: string): Promise<void> {
  const base = path.resolve(root)
  const relative = path.relative(base, path.resolve(file))
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`路径超出存储目录：${file}`)
  }
  let current = base
  for (const component of ['', ...relative.split(path.sep).filter(Boolean)]) {
    if (component) current = path.join(current, component)
    try {
      if ((await lstat(current)).isSymbolicLink()) throw new Error(`存储路径不能包含符号链接：${current}`)
    } catch (err) {
      if (isEnoent(err)) return
      throw err
    }
  }
}

export async function fileExists(file: string): Promise<boolean> {
  try {
    await stat(file)
    return true
  } catch (err) {
    if (isEnoent(err)) return false
    throw err
  }
}

export async function readFileIfExists(file: string): Promise<Buffer | undefined> {
  try {
    return await readFile(file)
  } catch (err) {
    if (isEnoent(err)) return undefined
    throw err
  }
}

export async function readJsonFile<T>(file: string): Promise<T | undefined> {
  const buf = await readFileIfExists(file)
  if (buf === undefined) return undefined
  try {
    return JSON.parse(buf.toString('utf8')) as T
  } catch (err) {
    throw new Error(`不是合法 JSON：${file}`, { cause: err })
  }
}

export async function readJsonLines<T>(file: string): Promise<T[]> {
  const buf = await readFileIfExists(file)
  if (buf === undefined) return []
  const lines = buf.toString('utf8').split('\n')
  const out: T[] = []
  for (const [i, line] of lines.entries()) {
    if (line.trim() === '') continue
    try {
      out.push(JSON.parse(line) as T)
    } catch (err) {
      throw new Error(`${file} 第 ${i + 1} 行不是合法 JSON`, { cause: err })
    }
  }
  return out
}

export async function appendLine(file: string, line: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true })
  const handle = await open(file, 'a')
  try {
    await handle.appendFile(`${line}\n`)
  } finally {
    await handle.close()
  }
}
