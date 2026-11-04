import { execFile } from 'node:child_process'
import { readdir, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { KnowledgeHit, KnowledgeQuery, KnowledgeSource } from '@taktflow/core'

const defaultIgnore = ['.git', 'node_modules', 'dist', '.takt/objects', '.takt/runs']

// 文件集合由两条检索路径共用；隐藏文件参与搜索，不读取 gitignore。
function pathPattern(pattern: string): RegExp {
  const anchored = pattern.startsWith('/')
  const normalized = pattern.replace(/^\.\//, '').replace(/^\/+|\/+$/g, '')
  let source = ''
  for (let i = 0; i < normalized.length; i++) {
    const char = normalized[i]!
    if (char === '*' && normalized[i + 1] === '*') {
      i++
      if (normalized[i + 1] === '/') {
        source += '(?:.*/)?'
        i++
      } else source += '.*'
    } else if (char === '*') source += '[^/]*'
    else if (char === '?') source += '[^/]'
    else source += char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`${anchored || normalized.includes('/') ? '^' : '(?:^|/)'}${source}(?:/|$)`)
}

async function collectFiles(root: string, ignore: RegExp[]): Promise<string[]> {
  const files: string[] = []
  async function walk(directory: string): Promise<void> {
    const entries = await readdir(resolve(root, directory), { withFileTypes: true })
    entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
    for (const entry of entries) {
      const path = directory ? `${directory}/${entry.name}` : entry.name
      if (entry.isSymbolicLink() || ignore.some(pattern => pattern.test(path))) continue
      if (entry.isDirectory()) await walk(path)
      else if (entry.isFile()) files.push(path)
    }
  }
  await walk('')
  return files
}

function runRg(root: string, text: string, files: string[]): Promise<string> {
  return new Promise((accept, reject) => {
    execFile('rg', [
      '--json', '--fixed-strings', '--multiline', '--hidden', '--no-ignore',
      '--no-follow', '--no-config', '--encoding', 'none', '-e', text, '--',
      ...files.map(file => `./${file}`),
    ], { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => {
      if (error && error.code !== 1) reject(error)
      else accept(stdout)
    })
  })
}

async function matchedFiles(root: string, text: string, files: string[]): Promise<Set<string>> {
  const matched = new Set<string>()
  for (let start = 0; start < files.length; start += 100) {
    const output = await runRg(root, text, files.slice(start, start + 100))
    for (const line of output.split('\n')) {
      if (!line) continue
      const event = JSON.parse(line) as {
        type: string
        data: { path?: { text?: string; bytes?: string } }
      }
      if (event.type !== 'match' || !event.data.path) continue
      const path = event.data.path.text ?? Buffer.from(event.data.path.bytes!, 'base64').toString('utf8')
      matched.add(path.replace(/^\.\//, ''))
    }
  }
  return matched
}

async function fileHits(root: string, path: string, text: string, fetchedAt: string): Promise<KnowledgeHit[]> {
  const buffer = await readFile(resolve(root, path))
  // rg 可能在遇到 NUL 前已经发出 match，必须检查整个文件才能一致跳过二进制。
  if (buffer.includes(0)) return []
  const content = buffer.toString('utf8')
  const lines = content.split('\n')
  if (lines.at(-1) === '') lines.pop()
  const hits: KnowledgeHit[] = []
  let offset = 0
  let match = content.indexOf(text)
  for (let index = 0; index < lines.length && match !== -1; index++) {
    const line = lines[index]!
    const nextLine = offset + line.length + 1
    if (match < nextLine) {
      const ref = `${path}:${index + 1}`
      hits.push({
        sourceId: 'grep', title: ref, ref,
        snippet: lines.slice(Math.max(0, index - 2), index + 3).join('\n'),
        score: 1, evidenceLevel: 'verified', fetchedAt,
      })
      // 同一行只返回一个 hit；游标只前进，避免无匹配时反复扫描后缀。
      match = content.indexOf(text, nextLine)
    }
    offset = nextLine
  }
  return hits
}

export function createGrepSource(options: { root: string; ignore?: string[] }): KnowledgeSource {
  const root = resolve(options.root)
  const ignore = [...defaultIgnore, ...options.ignore ?? []].filter(Boolean).map(pathPattern)
  return {
    id: 'grep', kind: 'grep', intents: ['symbol'],
    describe: () => '字面搜索项目文件，包含隐藏文件、不应用 gitignore；排除默认目录和追加 ignore，不跟随符号链接。rg 不存在时使用 Node。',
    async query(q: KnowledgeQuery) {
      if (!q.text) return []
      try {
        const scopes = q.scope?.map(pathPattern)
        const files = (await collectFiles(root, ignore))
          .filter(file => !scopes?.length || scopes.some(scope => scope.test(file)))
        let matched: Set<string>
        try {
          matched = await matchedFiles(root, q.text, files)
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
          matched = new Set(files)
        }
        const hits: KnowledgeHit[] = []
        const fetchedAt = new Date().toISOString()
        for (const file of files) {
          if (matched.has(file)) hits.push(...await fileHits(root, file, q.text, fetchedAt))
        }
        return hits
      } catch (error) {
        throw new Error(`grep 搜索失败（${root}）：${(error as Error).message}`, { cause: error })
      }
    },
  }
}
