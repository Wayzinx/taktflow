import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import type { HarnessRequest } from '@taktflow/core'
import { ToolPaths } from '../native/paths.js'
import { RpcError } from './protocol.js'

export class AcpFiles {
  private constructor(private readonly roots: ToolPaths[], private readonly readOnly: boolean) {}

  static async create(req: HarnessRequest): Promise<AcpFiles> {
    const roots = [req.cwd, ...(req.env?.TAKT_WORKSPACE ? [req.env.TAKT_WORKSPACE] : [])]
    return new AcpFiles(await Promise.all([...new Set(roots)].map(root => ToolPaths.create(root, ['**'], req.signal ?? new AbortController().signal))), !!req.readOnly)
  }

  async resolve(path: string, write = false): Promise<string> {
    if (!isAbsolute(path)) throw new RpcError(-32602, 'ACP 文件路径必须是绝对路径，请修正请求')
    if (write && this.readOnly) throw new RpcError(-32000, '只读运行拒绝写文件，请改用可写运行')
    for (const root of this.roots) {
      try { return await root.resolve(path, write) } catch { /* 只允许任一显式根目录内的真实路径。 */ }
    }
    throw new RpcError(-32000, '路径越界或符号链接逃逸，请使用工作目录或公共存放区内的文件')
  }

  async read(path: string, line?: number, limit?: number): Promise<string> {
    const actual = await this.resolve(path)
    const handle = await open(actual, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    try {
      if (!(await handle.stat()).isFile()) throw new RpcError(-32000, '只能读取普通文件，请检查路径')
      const content = await handle.readFile('utf8')
      if (line === undefined && limit === undefined) return content
      const start = Math.max(0, (line ?? 1) - 1)
      return content.split('\n').slice(start, limit === undefined ? undefined : start + limit).join('\n')
    } finally { await handle.close() }
  }

  async write(path: string, content: string): Promise<void> {
    const actual = await this.resolve(path, true)
    // 打开后再检查硬链接；不以 O_TRUNC 打开，避免校验前破坏文件。
    const handle = await open(actual, constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600)
    try {
      const info = await handle.stat()
      if (!info.isFile() || info.nlink !== 1) throw new RpcError(-32000, '只能写入无硬链接的普通文件，请检查路径')
      await handle.truncate(0)
      await handle.writeFile(content, 'utf8')
    } finally { await handle.close() }
  }
}
