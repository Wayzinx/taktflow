import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Actor } from '@taktflow/core'

export function runGit(args: string[], cwd?: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 15_000 }, (error, stdout, stderr) => {
      if (error && typeof error.code !== 'number') { reject(error); return }
      resolve({ code: error?.code as number ?? 0, stdout, stderr })
    })
  })
}

export async function mergeSources(base: string, ours: string, theirs: string): Promise<{ source: string; conflict: boolean }> {
  const dir = await mkdtemp(join(tmpdir(), 'takt-workflow-merge-'))
  try {
    const paths = ['ours.ts', 'base.ts', 'theirs.ts'].map((name) => join(dir, name))
    await Promise.all(paths.map((file, index) => writeFile(file, [ours, base, theirs][index]!)))
    const result = await runGit(['merge-file', '-p', '--diff3', '-L', 'ours', '-L', 'base', '-L', 'theirs', ...paths])
    if (result.code < 0 || result.code > 127) throw new Error(`三方合并失败：${result.stderr}`)
    return { source: result.stdout, conflict: result.code > 0 }
  } finally { await rm(dir, { recursive: true, force: true }) }
}

export async function sourceDiff(base: string, source: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'takt-workflow-diff-'))
  try {
    await Promise.all([writeFile(join(dir, 'before.ts'), base), writeFile(join(dir, 'after.ts'), source)])
    const result = await runGit(['diff', '--no-index', '--no-ext-diff', '--', 'before.ts', 'after.ts'], dir)
    if (result.code > 1) throw new Error(`生成修订差异失败：${result.stderr}`)
    return result.stdout
  } finally { await rm(dir, { recursive: true, force: true }) }
}

export async function commitWorkflow(file: string, author: Actor, reason: string): Promise<void> {
  const { dirname, basename } = await import('node:path')
  const dir = dirname(file)
  const repository = await runGit(['rev-parse', '--is-inside-work-tree'], dir)
  if (repository.code !== 0) return
  const name = (author.type === 'agent' ? `${author.role} (${author.harness})` : author.id).replace(/[<>\r\n]/g, ' ').trim() || author.type
  for (const args of [
    ['add', '--', basename(file)],
    ['-c', `user.name=${name}`, '-c', 'user.email=workflow@taktflow.local', 'commit', '--only', `--author=${name} <workflow@taktflow.local>`, '-m', reason, '--', basename(file)],
  ]) {
    const result = await runGit(args, dir)
    if (result.code !== 0) throw new Error(`源码已保存，但 git 提交失败：${result.stderr || result.stdout}`)
  }
}
