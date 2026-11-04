import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import * as knowledge from './index.js'

let root: string
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'takt-default-sources-')) })
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

it('统一导出全部工厂，默认包含 grep/workspace/git-history 和三个 stub', () => {
  for (const name of [
    'createGrepSource', 'createWikiSource', 'createWorkspaceSource', 'createGitHistorySource',
    'createCodeGraphSource', 'createDatabaseSource', 'createApiRegistrySource',
    'createKnowledgeRouter', 'createDefaultSources',
  ]) expect(knowledge).toHaveProperty(name, expect.any(Function))
  const sources = knowledge.createDefaultSources({ projectDir: root, taktDir: join(root, '.takt') })
  expect(sources.map(source => source.id)).toEqual(['grep', 'workspace', 'git-history', 'codegraph', 'database', 'api-registry'])
})

it.each(['relative', 'absolute'])('仅显式配置 wikiDir 加入 wiki，%s 路径指向项目 Wiki', async kind => {
  const wikiRoot = join(root, 'docs/wiki')
  await mkdir(wikiRoot, { recursive: true })
  await writeFile(join(wikiRoot, 'refund.md'), '# 退款规则\n\n订单退款规则说明。\n')
  const sources = knowledge.createDefaultSources({
    projectDir: root, taktDir: join(root, '.takt'),
    wikiDir: kind === 'relative' ? 'docs/wiki' : wikiRoot,
  })
  expect(sources).toHaveLength(7)
  const wiki = sources.find(source => source.kind === 'wiki')!
  expect((await wiki.query({ text: '退款规则' })).length).toBeGreaterThan(0)
})
