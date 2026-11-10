import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { systemWrite, WriteGuard } from './guard.js'

vi.mock('node:fs/promises', async importOriginal => {
  const fs = await importOriginal<typeof import('node:fs/promises')>()
  return { ...fs, readFile: vi.fn(fs.readFile) }
})

it('工作树哈希缓存只重读变化文件，忽略 .git 内部文件', async () => {
  const root = await mkdtemp(join(tmpdir(), 'takt-guard-cache-'))
  const dir = join(root, '.takt/worktrees/run-x/integration')
  try {
    await mkdir(join(dir, '.git'), { recursive: true })
    await writeFile(join(dir, 'a.txt'), 'a'); await writeFile(join(dir, 'b.txt'), 'b')
    const guard = new WriteGuard(root)
    const read = vi.mocked(readFile)
    const finish = await guard.begin({ profile: [] })
    read.mockClear()
    await writeFile(join(dir, '.git/index'), 'metadata')
    expect((await finish()).paths).toEqual([])
    const next = await guard.begin({ profile: [] })
    await systemWrite(root, ['.takt/worktrees/**'], async () => {})
    expect(read.mock.calls.filter(([file]) => String(file).startsWith(dir))).toEqual([])
    await writeFile(join(dir, 'a.txt'), 'changed')
    expect((await next()).paths).toEqual(['.takt/worktrees/run-x/integration/a.txt'])
    expect(read.mock.calls.filter(([file]) => String(file).startsWith(dir)).map(([file]) => file)).toEqual([join(dir, 'a.txt')])
  } finally { await rm(root, { recursive: true, force: true }) }
})
