import { expect, it } from 'vitest'
import { matchGlob } from '../util/glob.js'
import { intersectWriteScopes } from './scope.js'

it('目录和扩展名求交集，新建文件不必预先存在', () => {
  const scope = intersectWriteScopes(['src/**'], ['**/*.ts'])
  expect(scope).toContain('src/**/*.ts')
  for (const path of ['src/new.ts', 'src/deep/new.ts']) expect(scope.some((p) => matchGlob(p, path))).toBe(true)
  for (const path of ['test/new.ts', 'src/new.js']) expect(scope.some((p) => matchGlob(p, path))).toBe(false)
  expect(intersectWriteScopes(['src/**'], [])).toEqual([])
  expect(intersectWriteScopes([], ['**'])).toEqual([])
  expect(intersectWriteScopes(['src/**'])).toEqual(['src/**'])
})

it('glob 交集与双方独立匹配等价，包括多段、单字符、前后缀及数组 OR', () => {
  const patterns = ['**', 'src/**', '**/*.ts', 'src/*', 'src/?.ts', '**/a/**', '**/b/**', 'src/a*.ts', 'src/*b.ts', 'src/a?*', '**/a/**/b/*', 'src/**/a*/**', 'src/a*b*c', 'src/*b*a*', 'src/**/file?.*']
  const names = ['a', 'b', 'c', 'aa', 'ab', 'a.ts', 'b.ts', 'ab.ts', 'abc.ts', 'file1.ts', 'file1.js', 'aXbYc', 'bXaYb', '.hidden.ts']
  const prefixes = ['', 'src/', 'test/', 'src/deep/', 'src/a/b/', 'src/b/a/', 'a/', 'b/', 'a/b/', 'b/a/', 'src/a/b/c/']
  const paths = prefixes.flatMap((prefix) => names.map((name) => prefix + name))
  for (const left of patterns) for (const right of patterns) {
    const result = intersectWriteScopes([left], [right])
    for (const path of paths) expect(result.some((glob) => matchGlob(glob, path)), `${left} & ${right}: ${path} -> ${result.join(',')}`)
      .toBe(matchGlob(left, path) && matchGlob(right, path))
  }
  const result = intersectWriteScopes(['src/**', 'test/**'], ['**/*.ts', '**/*.json'])
  for (const path of [...paths, 'test/new.json']) expect(result.some((glob) => matchGlob(glob, path)))
    .toBe(['src/**', 'test/**'].some((p) => matchGlob(p, path)) && ['**/*.ts', '**/*.json'].some((p) => matchGlob(p, path)))
})


it('UTF-16 单字符通配与 matchGlob 一致，不把 emoji 放宽为一个 code unit', () => {
  expect(intersectWriteScopes(['?.ts'], ['😀.ts'])).toEqual([])
  expect(intersectWriteScopes(['??.ts'], ['😀.ts'])).toEqual(['😀.ts'])
})

it('有穷模式与路径穷举：空串、星号、问号、双星以及 Unicode', () => {
  const words = (alphabet: string[], length: number): string[] => length === 0 ? [''] : ['', ...words(alphabet, length - 1).flatMap((prefix) => alphabet.map((letter) => prefix + letter))]
  const segments = [...new Set([...words(['a', 'b', '*', '?'], 2), '**', '😀', '?😀', '😀?'])]
  const patterns = [...new Set([...segments, ...segments.map((s) => `**/${s}`), ...segments.map((s) => `${s}/**`), ...segments.map((s) => `a/${s}`)])]
  const names = [...new Set([...words(['a', 'b'], 2), '😀', 'a😀', '😀b'])]
  // 文件路径的段非空；空串也覆盖 matchGlob 的零长度语义。
  const paths = ['', ...names, ...names.filter(Boolean).flatMap((a) => names.filter(Boolean).map((b) => `${a}/${b}`)), 'a/b/a', 'b/a/b']
  const expected = new Map(patterns.map((pattern) => [pattern, paths.map((path) => matchGlob(pattern, path))]))
  for (const left of patterns) for (const right of patterns) {
    const actual = intersectWriteScopes([left], [right])
    for (const [index, path] of paths.entries()) {
      const wanted = expected.get(left)![index] && expected.get(right)![index]
      const got = actual.some((pattern) => matchGlob(pattern, path))
      if (got !== wanted) throw new Error(`${JSON.stringify({ left, right, path, actual, wanted, got })}`)
    }
  }
})
