import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { listFiles, matchGlob } from '@taktflow/core'
import type { KnowledgeHit, KnowledgeQuery, KnowledgeSource } from '@taktflow/core'

const defaultIgnore = ['.git', 'node_modules', 'dist', '.takt/objects', '.takt/runs']

// 保留 basename 在任意层级匹配、含斜杠的路径从根匹配的约定。
function pathGlob(pattern: string): string {
  const anchored = pattern.startsWith('/')
  const normalized = pattern.replace(/^\.\//, '').replace(/^\/+|\/+$/g, '')
  return anchored || normalized.includes('/') ? normalized : `**/${normalized}`
}

function matchesPath(pattern: string, path: string): boolean {
  const parts = path.split('/')
  return parts.some((_, index) => matchGlob(pattern, parts.slice(0, index + 1).join('/')))
}

async function collectFiles(root: string, ignore: string[]): Promise<string[]> {
  // listFiles 会将裸名称扩展到任意层级；根目录限定的裸名称用后置过滤，目录仍提前剪枝。
  const traversalIgnore = ignore.flatMap(pattern => pattern.includes('/') ? [pattern] : [`${pattern}/**`])
  return (await listFiles(root, ['**'], { ignore: traversalIgnore }))
    .filter(file => !ignore.some(pattern => matchesPath(pattern, file)))
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
  const ignore = [...defaultIgnore, ...options.ignore ?? []].filter(Boolean).map(pathGlob)
  return {
    id: 'grep', kind: 'grep', intents: ['symbol'],
    describe: () => '字面搜索项目文件，包含隐藏文件、不应用 gitignore；排除默认目录和追加 ignore，不跟随符号链接。rg 不存在时使用 Node。',
    async query(q: KnowledgeQuery) {
      if (!q.text) return []
      try {
        const scopes = q.scope?.map(pathGlob)
        const files = (await collectFiles(root, ignore))
          .filter(file => !scopes?.length || scopes.some(scope => matchesPath(scope, file)))
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
