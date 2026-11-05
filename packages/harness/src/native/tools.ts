import { constants } from 'node:fs'
import { mkdir, open, readFile, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { listFiles, type ToolCall, type ToolSpec } from '@taktflow/core'
import { checkAbort } from './abort.js'
import { runBash } from './bash.js'
import type { ToolPaths } from './paths.js'

const textLimit = 1_000_000
const string = { type: 'string' }
function spec(name: string, description: string, properties: Record<string, unknown>, required: string[]): ToolSpec {
  return { name, description, parameters: { type: 'object', properties, required, additionalProperties: false } }
}

export function toolSpecs(allowBash: boolean): ToolSpec[] {
  return [
    spec('read_file', 'Read a UTF-8 file relative to cwd.', { path: string }, ['path']),
    spec('write_file', 'Write a UTF-8 file within writeScope.', { path: string, content: string }, ['path', 'content']),
    spec('edit_file', 'Replace exactly one nonempty literal string in a file.', { path: string, old_string: string, new_string: string }, ['path', 'old_string', 'new_string']),
    spec('list', 'List files in a directory, optionally filtered by relative glob.', { path: string, glob: string }, []),
    spec('grep', 'Search a literal string in UTF-8 files and report matching lines.', { path: string, pattern: string, glob: string }, ['pattern']),
    ...(allowBash ? [spec('bash', process.platform === 'linux'
      ? 'Run bash with Linux bwrap, no network and read-only host files. writeScope binds complete /** subtrees or existing matching files; create other files with write_file first. Requires usable bwrap.'
      : 'Run bash with macOS sandbox-exec; regular-file writes only within writeScope. No network, links, directory mutations or background jobs. Requires sandbox-exec.', { command: string }, ['command'])] : []),
  ]
}

function field(args: Record<string, unknown>, key: string, fallback?: string): string {
  const value = args[key] ?? fallback
  if (typeof value !== 'string') throw new Error(`${key} must be a string`)
  return value
}

async function read(path: string, paths: ToolPaths): Promise<string> {
  checkAbort(paths.signal)
  const info = await stat(path)
  if (!info.isFile() || info.size > textLimit) throw new Error('Read requires a regular file at most 1 MB')
  return readFile(path, { encoding: 'utf8', signal: paths.signal })
}

async function write(input: string, content: string, paths: ToolPaths): Promise<void> {
  if (Buffer.byteLength(content) > textLimit) throw new Error('Write exceeds 1 MB limit')
  let path = await paths.resolve(input, true)
  checkAbort(paths.signal)
  await mkdir(dirname(path), { recursive: true })
  path = await paths.resolve(input, true)
  checkAbort(paths.signal)
  const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600)
  try {
    const info = await handle.stat()
    if (!info.isFile() || info.nlink !== 1) throw new Error('Write requires a regular file without hardlinks')
    const verified = await paths.resolve(input, true)
    const current = await stat(verified)
    if (verified !== path || current.ino !== info.ino || current.dev !== info.dev) throw new Error('Path changed during write preflight')
    checkAbort(paths.signal)
    await handle.truncate(0)
    checkAbort(paths.signal)
    await handle.writeFile(content, { encoding: 'utf8' })
  } finally { await handle.close() }
}

export async function executeTool(call: ToolCall, paths: ToolPaths, allowBash: boolean): Promise<string> {
  checkAbort(paths.signal)
  const args: unknown = JSON.parse(call.arguments)
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Tool arguments must be an object')
  const data = args as Record<string, unknown>
  if (call.name === 'read_file') return read(await paths.resolve(field(data, 'path')), paths)
  if (call.name === 'write_file') {
    await write(field(data, 'path'), field(data, 'content'), paths)
    return 'File written'
  }
  if (call.name === 'edit_file') {
    const input = field(data, 'path')
    const path = await paths.resolve(input, true)
    const old = field(data, 'old_string')
    const replacement = field(data, 'new_string')
    if (!old) throw new Error('old_string must not be empty')
    const content = await read(path, paths)
    const index = content.indexOf(old)
    if (index === -1) throw new Error('old_string was not found')
    if (content.indexOf(old, index + 1) !== -1) throw new Error('old_string is ambiguous')
    await write(input, content.slice(0, index) + replacement + content.slice(index + old.length), paths)
    return 'File edited'
  }
  if (call.name === 'list' || call.name === 'grep') {
    const dir = await paths.resolve(field(data, 'path', '.'))
    const files = await listFiles(dir, [field(data, 'glob', '**')])
    checkAbort(paths.signal)
    if (call.name === 'list') return files.join('\n').slice(0, textLimit)
    const pattern = field(data, 'pattern')
    if (!pattern) throw new Error('pattern must not be empty')
    let output = ''
    let skipped = 0
    for (const file of files) {
      let content: string
      try {
        const target = await paths.resolve(join(paths.relative(dir), file))
        content = await read(target, paths)
        if (/[\x00-\x08\x0e-\x1f\ufffd]/.test(content)) { skipped++; continue }
      } catch {
        checkAbort(paths.signal)
        skipped++
        continue
      }
      for (const [index, line] of content.split('\n').entries()) {
        if (line.includes(pattern)) output += `${file}:${index + 1}:${line}\n`
        if (output.length >= textLimit) return output.slice(0, textLimit) + (skipped ? `\nSkipped ${skipped} files (large, binary or unreadable).` : '')
      }
    }
    return output + (skipped ? `Skipped ${skipped} files (large, binary or unreadable).\n` : '')
  }
  if (call.name === 'bash') {
    if (!allowBash) throw new Error('bash is disabled; tools.allowBash must be true')
    return runBash(field(data, 'command'), paths)
  }
  throw new Error(`Unknown tool ${call.name}`)
}
