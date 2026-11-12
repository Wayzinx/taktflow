import { open } from 'node:fs/promises'
import { relative, resolve, sep } from 'node:path'
import { assertNoSymlinks, isEnoent } from '../store/fs-utils.js'
import { writableProjectFile } from '../commands/crud-commands.js'
import { StewardError } from './contracts.js'

/** 空间内相对路径落在需求目录下时，拆出需求 ID 和需求内路径。 */
export function requirementFile(root: string, requirementsDir: string, file: string): { id: string; path: string } | undefined {
  const dir = relative(root, requirementsDir).split(sep).join('/')
  if (!dir || dir.startsWith('..') || !file.startsWith(`${dir}/`)) return undefined
  const [id, ...rest] = file.slice(dir.length + 1).split('/')
  return id && rest.length ? { id, path: rest.join('/') } : undefined
}

export async function stewardFile(root: string, file: string, write = false): Promise<string> {
  if (
    !file ||
    file.includes('\\') ||
    file.startsWith('/') ||
    file
      .split('/')
      .some(
        (p) =>
          p === '..' ||
          p === '.' ||
          ['.takt', '.git', '.steward'].includes(p.toLowerCase()) ||
          p.toLowerCase().startsWith('.env'),
      ) ||
    /\.secret/i.test(file)
  ) {
    throw new StewardError(400, '文件路径不允许，请选择空间内的非敏感文件')
  }
  if (write && !writableProjectFile(file)) {
    if (/^workflows\/[^/]+\.workflow\.ts$/.test(file))
      throw new StewardError(400, 'workflow 源码不能当文件写：新建用 command workflow.create（可带 edits 一次建好节点），修改已有的用 kind=workflow')
    throw new StewardError(400, '文件不可写，请选择角色、技能、知识文档或 workflow 布局')
  }
  const target = resolve(root, file)
  await assertNoSymlinks(root, target)
  return target
}
export async function readStewardFile(root: string, file: string): Promise<string | undefined> {
  const target = await stewardFile(root, file)
  let handle
  try {
    handle = await open(target, 'r')
  } catch (error) {
    if (isEnoent(error)) return undefined
    throw error
  }
  try {
    const info = await handle.stat()
    if (!info.isFile() || info.size > 65536)
      throw new StewardError(400, '只支持读取不超过 64KB 的普通文本文件，请缩小文件')
    const buffer = Buffer.alloc(65537)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    if (bytesRead > 65536) throw new StewardError(400, '文件超过 64KB，请缩小文件')
    return buffer.subarray(0, bytesRead).toString('utf8')
  } finally {
    await handle.close()
  }
}
export function redactSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactSecrets)
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [
        key,
        /^(?:secret|password|api.?key|authorization|credential|connection(?:string)?|dsn)$|(?<!s)token$/i.test(
          key,
        )
          ? '***'
          : redactSecrets(child),
      ]),
    )
  if (typeof value === 'string' && /(?:secret:|\$\{env:|:\/\/[^/\s]+:[^/\s]+@)/.test(value))
    return '***'
  return value
}
