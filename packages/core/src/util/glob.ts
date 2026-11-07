import { readdir } from 'node:fs/promises'
import { join, posix } from 'node:path'

const defaultIgnore = ['**/.git', '**/node_modules', '**/.takt/objects', '**/.takt/runs', '**/dist']

export function matchGlob(pattern: string, path: string): boolean {
  let source = '^'
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i]!
    if (char === '*') {
      if (pattern[i + 1] === '*' && (i === 0 || pattern[i - 1] === '/') &&
          (i + 2 === pattern.length || pattern[i + 2] === '/')) {
        if (pattern[i + 2] === '/') {
          source += '(?:[^/]+/)*'
          i += 2
        } else {
          source += '.*'
          i++
        }
      } else source += '[^/]*'
    } else if (char === '?') source += '[^/]'
    else source += char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`${source}$`).test(path)
}

export async function listFiles(
  dir: string,
  patterns: string[],
  /** limit：最多收集这么多个文件就停（用于只做计数的快速扫描）。 */
  options: { ignore?: string[]; limit?: number } = {},
): Promise<string[]> {
  const ignore = (options.ignore ?? defaultIgnore).map((pattern) => {
    const trimmed = pattern.replace(/\/+$/, '')
    return trimmed.includes('/') ? trimmed : `**/${trimmed}`
  })
  const files: string[] = []
  const walk = async (relativeDir: string): Promise<void> => {
    const entries = await readdir(join(dir, relativeDir), { withFileTypes: true })
    for (const entry of entries) {
      if (options.limit !== undefined && files.length >= options.limit) return
      const path = relativeDir ? `${relativeDir}/${entry.name}` : entry.name
      if (ignore.some((pattern) => matchGlob(pattern, path) ||
          (entry.isDirectory() && matchGlob(pattern, `${path}/`)))) continue
      if (entry.isDirectory()) await walk(path)
      else if (entry.isFile() && patterns.some((pattern) => matchGlob(pattern, path))) files.push(path)
    }
  }
  await walk('')
  return files.sort()
}

// 静态前缀无法证明互斥时保守相交；目录段有边界，通配符前的文件名前缀没有。
export function globsOverlap(left: string, right: string): boolean {
  const prefix = (value: string) => {
    const path = posix.normalize(value.replace(/\\/g, '/'))
    if (path === '.' || path.split('/').includes('..')) return { value: '', glob: true }
    const index = path.search(/[*?{[!(]/)
    return { value: index < 0 ? path : path.slice(0, index), glob: index >= 0 }
  }
  const a = prefix(left), b = prefix(right)
  const contains = (x: typeof a, y: typeof a) => y.value === x.value || y.value.startsWith(x.value.endsWith('/') || x.glob ? x.value : `${x.value}/`)
  return contains(a, b) || contains(b, a)
}
