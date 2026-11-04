import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { initProject } from '@taktflow/core'
import { knowledgeFromConfig } from './knowledge.js'
import { UsageError } from './args.js'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))) })
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'takt-knowledge-config-'))
  roots.push(root)
  return initProject(root)
}

it('每个配置源保留 ID，使用各自路径和选项，显式空列表不添加默认源', async () => {
  const stores = await fixture()
  for (const folder of ['wiki-a', 'wiki-b', 'code']) await mkdir(join(stores.projectDir, folder))
  await writeFile(join(stores.projectDir, 'wiki-a/rules.md'), '# 空名字问候语\n\n空名字使用 stranger')
  await writeFile(join(stores.projectDir, 'wiki-b/rules.md'), '# 名字问候语\n\n名字保持原样')
  await writeFile(join(stores.projectDir, 'code/skip.js'), 'greet')
  await writeFile(join(stores.projectDir, 'code/use.js'), 'greet')
  stores.config.knowledge = [
    { id: 'a', kind: 'wiki', options: { root: 'wiki-a' } },
    { id: 'b', kind: 'wiki', options: { root: 'wiki-b' } },
    { id: 'code', kind: 'grep', options: { root: 'code', ignore: ['skip.js'] } },
    { id: 'past', kind: 'workspace', options: { taktDir: '.takt' } },
    { id: 'history', kind: 'git-history', options: { root: '.' } },
    ...['codegraph', 'database', 'api-registry'].map((kind) => ({ id: kind, kind })),
  ]
  const sources = knowledgeFromConfig(stores)
  expect(sources.map((source) => source.id)).toEqual(['a', 'b', 'code', 'past', 'history', 'codegraph', 'database', 'api-registry'])
  expect(await sources[0]!.query({ text: '空名字', intent: 'business' })).toEqual(expect.arrayContaining([expect.objectContaining({ sourceId: 'a' })]))
  expect(await sources[1]!.query({ text: '名字', intent: 'business' })).toEqual(expect.arrayContaining([expect.objectContaining({ sourceId: 'b' })]))
  expect((await sources[2]!.query({ text: 'greet' })).map((hit) => hit.ref)).toEqual(['use.js:1'])
  stores.config.knowledge = []
  expect(knowledgeFromConfig(stores)).toEqual([])
  delete stores.config.knowledge
  expect(knowledgeFromConfig(stores).length).toBeGreaterThan(0)
})

it('未知源与无效选项产生可操作的配置错误', async () => {
  const stores = await fixture()
  for (const entry of [
    { id: 'bad', kind: 'custom' },
    { id: 'bad', kind: 'grep', options: { ignore: 'not-array' } },
    { id: 'bad', kind: 'wiki', options: { root: 123 } },
    { id: 'bad', kind: 'wiki', options: { typo: 'docs' } },
  ]) {
    stores.config.knowledge = [entry]
    expect(() => knowledgeFromConfig(stores)).toThrow(UsageError)
  }
})
