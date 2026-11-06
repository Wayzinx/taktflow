import { randomBytes } from 'node:crypto'
import { link, mkdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { ProjectStores } from '../interfaces.js'
import { sha256 } from '../util/hash.js'
import { assertNoSymlinks, readFileIfExists } from './fs-utils.js'
import { SHA256 } from './hash-chain.js'

type ObjectRoot = string | Pick<ProjectStores, 'taktDir'>
const rootOf = (stores: ObjectRoot): string => typeof stores === 'string' ? stores : stores.taktDir

/** 字符串参数为 .takt 目录；读取即验证内容地址，不把损坏正文交给采集和回放。 */
export async function getObject(stores: ObjectRoot, hash: string): Promise<Buffer> {
  if (!SHA256.test(hash)) throw new Error(`非法对象 sha256：${hash}`)
  const root = rootOf(stores)
  const file = path.join(root, 'objects', hash)
  await assertNoSymlinks(root, file)
  const content = await readFileIfExists(file)
  if (content === undefined) throw new Error(`对象缺失：${hash}`)
  if (sha256(content) !== hash) throw new Error(`对象 hash 校验失败：${hash}`)
  return content
}

export async function putObject(stores: ObjectRoot, content: Buffer | string): Promise<string> {
  const root = rootOf(stores)
  const bytes = Buffer.from(content)
  const hash = sha256(bytes)
  const file = path.join(root, 'objects', hash)
  await assertNoSymlinks(root, file)
  await mkdir(path.dirname(file), { recursive: true })
  const temporary = `${file}.${randomBytes(8).toString('hex')}.tmp`
  try {
    await writeFile(temporary, bytes, { flag: 'wx', mode: 0o444 })
    try { await link(temporary, file) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
    await getObject(stores, hash)
  } finally { await rm(temporary, { force: true }) }
  return hash
}
