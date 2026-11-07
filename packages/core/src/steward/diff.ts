import { execFile } from 'node:child_process'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export async function proposalDiff(file: string, before: string, after: string): Promise<string> {
  if (before === after) return ''
  const dir = await mkdtemp(join(tmpdir(), 'takt-proposal-diff-'))
  try {
    await Promise.all([
      writeFile(join(dir, 'before'), before),
      writeFile(join(dir, 'after'), after),
    ])
    const output = await new Promise<string>((resolve, reject) => {
      execFile(
        'git',
        ['diff', '--no-index', '--no-ext-diff', '--no-textconv', '--', 'before', 'after'],
        { cwd: dir, encoding: 'utf8', timeout: 15000, maxBuffer: 1024 * 1024 },
        (error, stdout) => {
          if (error && error.code !== 1) reject(new Error('生成提案差异失败，请检查 git 是否可用'))
          else resolve(stdout)
        },
      )
    })
    return output.replaceAll('a/before', `a/${file}`).replaceAll('b/after', `b/${file}`)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}
