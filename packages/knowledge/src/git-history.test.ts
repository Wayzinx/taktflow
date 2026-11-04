import { execFile } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createGitHistorySource } from './git-history.js'

vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return { ...actual, execFile: vi.fn(actual.execFile) }
})

let root: string
const run = promisify(execFile)
async function git(...args: string[]): Promise<string> {
  return (await run('git', args, { cwd: root, encoding: 'utf8' })).stdout.trim()
}
async function init(): Promise<void> {
  await git('init', '--initial-branch=main')
  await git('config', 'user.name', 'Knowledge Test')
  await git('config', 'user.email', 'knowledge@example.invalid')
  await git('config', 'commit.gpgsign', 'false')
  await git('config', 'core.hooksPath', join(root, 'no-hooks'))
}
async function commit(title: string): Promise<string> {
  await git('add', '.')
  await git('commit', '-m', title)
  return git('rev-parse', 'HEAD')
}
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'takt-history-')) })
afterEach(async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process')
  vi.mocked(execFile).mockReset().mockImplementation(actual.execFile)
  await rm(root, { recursive: true, force: true })
})

describe('git history', () => {
  it('真实仓库按 -S 取最近 10 条，返回 hash、标题和文件名', async () => {
    await init()
    const hashes: string[] = []
    for (let index = 0; index < 12; index++) {
      await writeFile(join(root, 'file name.ts'), 'literal.[x]()\n'.repeat(index + 1))
      hashes.push(await commit(`change ${index}`))
    }
    await writeFile(join(root, 'unrelated.txt'), 'literalx')
    await commit('unrelated')
    const source = createGitHistorySource({ root })
    const hits = await source.query({ text: 'literal.[x]()' })
    expect(hits.map(hit => hit.ref)).toEqual(hashes.reverse().slice(0, 10))
    expect(hits[0]).toMatchObject({ title: 'change 11', snippet: 'change 11\nfile name.ts', sourceId: 'git-history' })
    for (const hit of hits) {
      expect(hit.evidenceLevel).toBe('derived')
      expect(new Date(hit.fetchedAt!).toISOString()).toBe(hit.fetchedAt)
    }
    expect(await source.query({ text: 'missing' })).toEqual([])
  })

  it('scope 传给 git pathspec，多个改动文件均列出', async () => {
    await init()
    await mkdir(join(root, 'src'))
    await writeFile(join(root, 'src/a.ts'), 'needle')
    await writeFile(join(root, 'src/b.ts'), 'needle')
    const first = await commit('first title')
    await writeFile(join(root, 'outside.ts'), 'needle')
    await commit('outside')
    const hits = await createGitHistorySource({ root }).query({ text: 'needle', scope: ['src'] })
    expect(hits).toHaveLength(1)
    expect(hits[0]).toMatchObject({ ref: first, snippet: 'first title\nsrc/a.ts\nsrc/b.ts' })
  })

  it('40 位十六进制标题不会被识别成新提交', async () => {
    await init()
    const title = 'a'.repeat(40)
    await writeFile(join(root, 'a.ts'), 'needle')
    const hash = await commit(title)
    const hits = await createGitHistorySource({ root }).query({ text: 'needle' })
    expect(hits).toHaveLength(1)
    expect(hits[0]).toMatchObject({ ref: hash, title, snippet: `${title}\na.ts` })
  })

  it('非首文件的 40 位十六进制文件名不会分裂提交，特殊路径原样保留', async () => {
    await init()
    const hexPath = 'b'.repeat(40)
    const paths = ['0-first.ts', hexPath, 'z\nfile\tname.ts']
    for (const path of paths) await writeFile(join(root, path), 'needle')
    const hash = await commit('paths')
    const hits = await createGitHistorySource({ root }).query({ text: 'needle' })
    expect(hits).toHaveLength(1)
    expect(hits[0]).toMatchObject({ ref: hash, title: 'paths', snippet: ['paths', ...paths].join('\n') })
  })

  it('空标题与相邻普通提交分别保留，路径开头的换行不被裁掉', async () => {
    await init()
    const path = '\nleading.ts'
    await writeFile(join(root, path), 'needle')
    await git('add', '.')
    await git('commit', '--allow-empty-message', '-m', '')
    const emptyHash = await git('rev-parse', 'HEAD')
    await writeFile(join(root, 'normal.ts'), 'needle')
    const normalHash = await commit('normal')
    const hits = await createGitHistorySource({ root }).query({ text: 'needle' })
    expect(hits.map(({ ref, title, snippet }) => ({ ref, title, snippet }))).toEqual([
      { ref: normalHash, title: 'normal', snippet: 'normal\nnormal.ts' },
      { ref: emptyHash, title: '', snippet: `\n${path}` },
    ])
  })

  it('非仓库、空仓库和空查询返回空数组', async () => {
    const source = createGitHistorySource({ root })
    expect(await source.query({ text: 'needle' })).toEqual([])
    await init()
    expect(await source.query({ text: 'needle' })).toEqual([])
    expect(await source.query({ text: '' })).toEqual([])
  })

  it('缺失目录不是非仓库，错误包含上下文', async () => {
    await expect(createGitHistorySource({ root: join(root, 'missing') }).query({ text: 'needle' }))
      .rejects.toThrow('git-history 搜索失败')
  })

  it('其余 git 错误不能吞掉', async () => {
    vi.mocked(execFile).mockImplementationOnce((...args: unknown[]) => {
      const callback = args.at(-1) as (error: Error, stdout: string, stderr: string) => void
      callback(Object.assign(new Error('bad object HEAD'), { code: 128 }), '', 'fatal: bad object HEAD')
      return {} as ChildProcess
    })
    await expect(createGitHistorySource({ root }).query({ text: 'needle' }))
      .rejects.toThrow(`git-history 搜索失败（${root}）：bad object HEAD`)
  })
})
