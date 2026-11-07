import { execFile } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createGrepSource } from './grep.js'

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return { ...actual, execFile: vi.fn(actual.execFile) }
})

let root: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'takt-grep-'))
})
afterEach(async () => {
  vi.mocked(execFile).mockReset()
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process')
  vi.mocked(execFile).mockImplementation(actual.execFile)
  await rm(root, { recursive: true, force: true })
})

function failRg(code: string | number): void {
  vi.mocked(execFile).mockImplementation((...args: unknown[]) => {
    const callback = args.at(-1) as (error: Error, stdout: string, stderr: string) => void
    callback(Object.assign(new Error(`simulated ${code}`), { code }), '', '')
    return {} as ChildProcess
  })
}

async function put(path: string, text: string | Buffer): Promise<void> {
  const file = join(root, path)
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, text)
}

async function fixture(): Promise<void> {
  const text = 'first\nbefore two\nbefore one\na.b[0]() + $needle\nafter one\nafter two\nlast\n'
  await put('src/main.ts', text)
  await put('src/other.ts', 'axb0\nno match\n')
  await put('.hidden', text)
  await put('.private/source.ts', text)
  await put('.gitignore', 'ignored-by-git.ts\n')
  await put('ignored-by-git.ts', text)
  for (const path of [
    '.git/config',
    'node_modules/pkg/index.ts',
    'dist/out.js',
    '.takt/objects/object',
    '.takt/runs/run/log',
    'src/node_modules/deep.ts',
    'custom/file.ts',
    'src/generated.ts',
    'src/cache/file.ts',
  ])
    await put(path, text)
  await put('binary.bin', Buffer.from(`${text}\0tail`))
  await put('late-binary.bin', Buffer.from(`${text}${'x'.repeat(100_000)}\0tail`))
  await symlink(join(root, 'src/main.ts'), join(root, 'linked.ts'))
  await symlink(join(root, 'src'), join(root, 'linked-dir'))
}

describe('grep', () => {
  it('真实 rg 和 ENOENT fallback 的 literal、ignore、hidden、gitignore、binary、symlink、context 一致', async () => {
    await fixture()
    const source = createGrepSource({ root, ignore: ['custom', '**/generated.*', '**/cache/**'] })
    const query = { text: 'a.b[0]() + $needle' }
    const real = await source.query(query)
    expect(execFile).toHaveBeenCalledWith(
      'rg',
      expect.arrayContaining(['--json', '--fixed-strings']),
      expect.anything(),
      expect.any(Function),
    )
    expect(real.map((hit) => hit.ref)).toEqual([
      '.hidden:4',
      '.private/source.ts:4',
      'ignored-by-git.ts:4',
      'src/main.ts:4',
    ])
    for (const hit of real) {
      expect(hit.snippet).toBe('before two\nbefore one\na.b[0]() + $needle\nafter one\nafter two')
      expect(hit.evidenceLevel).toBe('verified')
      expect(new Date(hit.fetchedAt!).toISOString()).toBe(hit.fetchedAt)
    }
    failRg('ENOENT')
    expect(await source.query(query)).toEqual(
      real.map((hit) => ({ ...hit, fetchedAt: expect.any(String) })),
    )
  })

  it.each(['rg', 'fallback'])('%s：不存在、空文本、边界和每行一个 hit', async (mode) => {
    await put('file.ts', 'needle needle\nsecond\nthird\nneedle\n')
    if (mode === 'fallback') failRg('ENOENT')
    const source = createGrepSource({ root })
    expect(await source.query({ text: 'missing' })).toEqual([])
    expect(await source.query({ text: '' })).toEqual([])
    const hits = await source.query({ text: 'needle' })
    expect(hits.map((hit) => hit.ref)).toEqual(['file.ts:1', 'file.ts:4'])
    expect(hits.map((hit) => hit.snippet)).toEqual([
      'needle needle\nsecond\nthird',
      'second\nthird\nneedle',
    ])
  })

  it.each(['rg', 'fallback'])('%s：scope、特殊文件名及多行字面文本', async (mode) => {
    await put('src/-odd name.ts', 'prefix\nneedle\nsecond\nend\n')
    await put('other.ts', 'needle\nsecond\n')
    if (mode === 'fallback') failRg('ENOENT')
    const source = createGrepSource({ root })
    expect(
      (await source.query({ text: 'needle\nsecond', scope: ['src'] })).map((hit) => hit.ref),
    ).toEqual(['src/-odd name.ts:2'])
  })

  it.each(['EACCES', 2])('rg 错误 %s 带上下文抛出而不降级', async (code) => {
    await put('file.ts', 'needle')
    failRg(code)
    await expect(createGrepSource({ root }).query({ text: 'needle' })).rejects.toThrow(
      `grep 搜索失败（${root}）`,
    )
  })

  it.each(['rg', 'fallback'])(
    '%s：共享 glob 保留根路径、basename、目录和 scope 的边界',
    async (mode) => {
      for (const path of [
        'root-only.ts',
        'nested/root-only.ts',
        'cache/a.ts',
        'nested/cache/a.ts',
        'generated/a.ts',
        'nested/generated/a.ts',
        'src/skip1.ts',
        'src/keep.ts',
        'src-other/keep.ts',
        'nested/src/keep.ts',
        'nested/dist/out.ts',
        '.takt/runs/log',
        'nested/.takt/runs/log',
      ])
        await put(path, 'needle')
      if (mode === 'fallback') failRg('ENOENT')
      const source = createGrepSource({
        root,
        ignore: ['/root-only.ts', '/cache/', './generated/', 'src/skip?.ts'],
      })
      expect((await source.query({ text: 'needle' })).map((hit) => hit.ref)).toEqual([
        'nested/.takt/runs/log:1',
        'nested/cache/a.ts:1',
        'nested/root-only.ts:1',
        'nested/src/keep.ts:1',
        'src-other/keep.ts:1',
        'src/keep.ts:1',
      ])
      expect(
        (await source.query({ text: 'needle', scope: ['/src/'] })).map((hit) => hit.ref),
      ).toEqual(['src/keep.ts:1'])
      expect(
        (await source.query({ text: 'needle', scope: ['src'] })).map((hit) => hit.ref),
      ).toEqual(['nested/src/keep.ts:1', 'src/keep.ts:1'])
    },
  )

  it('缺失 root 抛出上下文错误', async () => {
    await expect(
      createGrepSource({ root: join(root, 'missing') }).query({ text: 'needle' }),
    ).rejects.toThrow('grep 搜索失败')
  })

  it('fallback 大量不匹配行只向前扫描，末行仍返回正确位置', async () => {
    await put('large.ts', `${'no match here\n'.repeat(100_000)}needle\n`)
    failRg('ENOENT')
    const hits = await createGrepSource({ root }).query({ text: 'needle' })
    expect(hits.map((hit) => hit.ref)).toEqual(['large.ts:100001'])
    expect(hits[0]?.snippet).toBe('no match here\nno match here\nneedle')
  })
})
