import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { link, lstat, mkdir, open, readdir, rename, rm } from 'node:fs/promises'
import { join, parse, resolve } from 'node:path'
import { assertNoSymlinks } from '@taktflow/core'

const recordName = /^[a-f0-9]{64}\.json$/
const temporaryName = /^\.queue-[a-f0-9-]{36}\.tmp$/

export class FeishuQueueStore {
  readonly root: string

  constructor(root: string) {
    const absolute = resolve(root)
    this.root = process.platform === 'darwin' && /^\/(?:var|tmp)\//.test(absolute) ? `/private${absolute}` : absolute
  }

  async list(): Promise<string[]> {
    await assertNoSymlinks(parse(this.root).root, this.root)
    await mkdir(this.root, { recursive: true, mode: 0o700 })
    const info = await lstat(this.root)
    if (!info.isDirectory() || (info.mode & 0o022) !== 0) throw new Error('飞书队列需要一个不可由其他用户写入的目录')
    const names = await readdir(this.root)
    for (const name of names) if (temporaryName.test(name)) await this.remove(name)
    return names.filter(name => recordName.test(name))
  }

  async read(name: string): Promise<unknown> {
    const file = join(this.root, name)
    await assertNoSymlinks(this.root, file)
    const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    try {
      if (!(await handle.stat()).isFile()) throw new Error('飞书队列记录不是普通文件')
      return JSON.parse(await handle.readFile('utf8')) as unknown
    } finally {
      await handle.close()
    }
  }

  async save<T>(name: string, value: T): Promise<T>
  async save<T>(name: string, value: T, create: true): Promise<T | undefined>
  async save<T>(name: string, value: T, create = false): Promise<T | undefined> {
    const file = join(this.root, name)
    await assertNoSymlinks(this.root, file)
    if (create) {
      try {
        if (!(await lstat(file)).isFile()) throw new Error('飞书队列记录不是普通文件')
        return undefined
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
    const data = JSON.stringify(value)
    const temporary = `.queue-${randomUUID()}.tmp`
    const tmp = join(this.root, temporary)
    const handle = await open(tmp, 'wx', 0o600)
    try {
      try {
        await handle.writeFile(data)
        await handle.sync()
      } finally {
        await handle.close()
      }
      if (create) {
        try { await link(tmp, file) } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'EEXIST') return undefined
          throw error
        }
      } else {
        await rename(tmp, file)
      }
      const dir = await open(this.root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
      try { await dir.sync() } finally { await dir.close() }
      return JSON.parse(data) as T
    } finally {
      await this.remove(temporary)
    }
  }

  async remove(name: string): Promise<void> {
    await assertNoSymlinks(this.root, this.root)
    await rm(join(this.root, name), { force: true })
  }
}
