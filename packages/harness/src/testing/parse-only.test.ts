import { readFile } from 'node:fs/promises'
import { expect, it } from 'vitest'
import { createCliParser } from '../adapters/cli-generic.js'
import { parseHarnessStream, runHarnessConformance } from './index.js'
import type { HarnessConformanceOptions } from './index.js'
import { genericConfig, genericFixtures } from './fixtures.js'

// 社区的最小调用：只有 parse 和 fixtures，不需要创建可执行文件或提供运行时选项。
const options = {
  parse: parseHarnessStream(onEvent => createCliParser(genericConfig, onEvent)),
  fixtures: genericFixtures,
} satisfies HarnessConformanceOptions
runHarnessConformance('community parse-only', options)


it('package.json 声明独立 testing 类型与 ESM 入口，不依赖 dist 存在', async () => {
  const pkg = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8'))
  expect(pkg.exports['./testing']).toEqual({ types: './dist/testing/index.d.ts', import: './dist/testing/index.js' })
  expect(pkg.exports['.']).toEqual({ types: './dist/index.d.ts', import: './dist/index.js' })
})
