import { readdir } from 'node:fs/promises'
import { join } from 'node:path'

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
  options: { ignore?: string[] } = {},
): Promise<string[]> {
  const ignore = (options.ignore ?? defaultIgnore).map((pattern) => {
    const trimmed = pattern.replace(/\/+$/, '')
    return trimmed.includes('/') ? trimmed : `**/${trimmed}`
  })
  const files: string[] = []
  const walk = async (relativeDir: string): Promise<void> => {
    const entries = await readdir(join(dir, relativeDir), { withFileTypes: true })
    for (const entry of entries) {
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
