import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { listFiles, matchGlob } from './glob.js'

const dirs: string[] = []
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))) })

describe('matchGlob', () => {
  it.each([
    ['**/*.ts', 'a.ts', true],
    ['**/*.ts', 'src/deep/a.ts', true],
    ['src/**/a?.ts', 'src/a1.ts', true],
    ['src/**/a?.ts', 'src/deep/a2.ts', true],
    ['src/**/a?.ts', 'src/a12.ts', false],
    ['src/*', 'src/deep/a.ts', false],
    ['src/?', 'src//', false],
    ['a[1]+(x).ts', 'a[1]+(x).ts', true],
    ['a[1]+(x).ts', 'a1x.ts', false],
    ['**', '.hidden/file', true],
    ['*.ts', 'file.ts.bak', false],
  ])('%s matches %s: %s', (pattern, path, expected) => {
    expect(matchGlob(pattern, path)).toBe(expected)
  })
})

describe('listFiles', () => {
  async function fixture(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'takt-glob-'))
    dirs.push(dir)
    for (const path of [
      'a.ts', 'src/a.ts', 'src/nested/b.ts', 'src/notes.md', '.hidden/a.ts',
      '.git/config', 'node_modules/pkg/a.ts', 'dist/a.ts', '.takt/objects/hash',
      '.takt/runs/id/state.json', '.takt/workspaces/REQ-001/spec.md',
      'nested/node_modules/pkg/a.ts', 'nested/.git/config', 'nested/dist/a.ts',
      'nested/.takt/objects/hash', 'nested/.takt/runs/state.json',
    ]) {
      await mkdir(dirname(join(dir, path)), { recursive: true })
      await writeFile(join(dir, path), path)
    }
    return dir
  }

  it('returns sorted relative slash paths and prunes default directories at every depth', async () => {
    const dir = await fixture()
    expect(await listFiles(dir, ['**'])).toEqual([
      '.hidden/a.ts', '.takt/workspaces/REQ-001/spec.md', 'a.ts',
      'src/a.ts', 'src/nested/b.ts', 'src/notes.md',
    ])
    expect(await listFiles(dir, ['**/*.ts', 'src/**'])).toEqual([
      '.hidden/a.ts', 'a.ts', 'src/a.ts', 'src/nested/b.ts', 'src/notes.md',
    ])
  })

  it('allows empty or replacement ignores and supports recursive directory ignores', async () => {
    const dir = await fixture()
    expect(await listFiles(dir, ['**'], { ignore: [] })).toHaveLength(16)
    expect(await listFiles(dir, ['**/*.ts'], { ignore: ['src/**', 'node_modules/', 'dist'] }))
      .toEqual(['.hidden/a.ts', 'a.ts'])
    expect(await listFiles(dir, ['**'], { ignore: ['**'] })).toEqual([])
    expect(await listFiles(dir, [])).toEqual([])
  })

  it('does not follow symlinks into external directories or cycles', async () => {
    const dir = await fixture()
    await symlink(dir, join(dir, 'src', 'cycle'))
    await symlink(join(dir, 'a.ts'), join(dir, 'linked.ts'))
    expect(await listFiles(dir, ['**/*.ts'])).toEqual(['.hidden/a.ts', 'a.ts', 'src/a.ts', 'src/nested/b.ts'])
  })

  it('propagates missing root errors', async () => {
    const dir = await fixture()
    await expect(listFiles(join(dir, 'missing'), ['**'])).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
