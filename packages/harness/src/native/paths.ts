import { lstat, realpath, stat } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep, dirname, basename } from 'node:path'
import { matchGlob } from '@taktflow/core'
import { checkAbort } from './abort.js'

function inside(root: string, path: string): string {
  const rel = relative(root, path)
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('Path escapes cwd')
  return rel.split(sep).join('/')
}

export class ToolPaths {
  private constructor(readonly cwd: string, readonly root: string, readonly scope: string[], readonly signal: AbortSignal) {}

  static async create(cwd: string, scope: string[] | undefined, signal: AbortSignal): Promise<ToolPaths> {
    checkAbort(signal)
    const root = await realpath(cwd)
    if (!(await stat(root)).isDirectory()) throw new Error('cwd must be a directory')
    for (const pattern of scope ?? []) {
      if (!pattern || isAbsolute(pattern) || pattern.split('/').some((part) => part === '..' || part === '.' || !part) || pattern.includes('\\') || /[\x00-\x1f]/.test(pattern)) {
        throw new Error('writeScope must contain normalized relative glob patterns')
      }
    }
    return new ToolPaths(resolve(cwd), root, scope ?? [], signal)
  }

  allows(path: string): boolean { return this.scope.some((pattern) => matchGlob(pattern, path)) }

  async resolve(input: string, write = false): Promise<string> {
    checkAbort(this.signal)
    if (!input || input.includes('\0')) throw new Error('A nonempty path is required')
    const lexical = resolve(this.cwd, input)
    const rel = inside(this.cwd, lexical)
    if (write && (!rel || !this.allows(rel))) throw new Error('Write denied by writeScope')
    let existing = lexical
    const missing: string[] = []
    while (true) {
      try { await lstat(existing); break } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        missing.unshift(basename(existing))
        const parent = dirname(existing)
        if (parent === existing) throw new Error('No existing path ancestor')
        existing = parent
      }
    }
    const actual = resolve(await realpath(existing), ...missing)
    const resolvedRel = inside(this.root, actual)
    if (write && (!resolvedRel || !this.allows(resolvedRel))) throw new Error('Resolved path denied by writeScope')
    if (missing.length === 0) {
      const info = await stat(actual)
      if (write && (!info.isFile() || info.nlink !== 1)) throw new Error('Write requires a regular file without hardlinks')
    }
    checkAbort(this.signal)
    return actual
  }

  relative(path: string): string { return inside(this.root, path) }
}
