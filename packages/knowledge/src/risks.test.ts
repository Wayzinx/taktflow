import { afterEach, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  openProject,
  type KnowledgeBase,
  type KnowledgeBuild,
  type KnowledgeEvalRun,
  type KnowledgeStore,
} from '@taktflow/core'
import { knowledgeRisks } from './risks.js'
import { metrics } from './eval/metrics.js'
import { appendQuery } from './store/query-log.js'
const roots: string[] = []
const now = new Date('2026-11-07T12:00:00Z')
const by = { type: 'human' as const, id: 't' }
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'takt-kb-risks-'))
  roots.push(root)
  await writeFile(
    join(root, 'takt.config.json'),
    JSON.stringify({ project: { name: 'test' }, workflows: [] }),
  )
  const stores = await openProject(root)
  const base: KnowledgeBase = {
    id: 'docs',
    name: '文档',
    kind: 'rag',
    description: '',
    config: {},
    intents: [],
    scope: 'space',
    version: 1,
    retrieval: { topK: 10, budgetTokens: 4000 },
    status: 'ready',
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    createdBy: by,
  }
  const builds: KnowledgeBuild[] = []
  const runs: KnowledgeEvalRun[] = []
  stores.kb = {
    list: async () => [base],
    builds: async () => builds,
    evalRuns: async () => runs,
  } as unknown as KnowledgeStore
  return { stores, base, builds, runs, space: { id: 'space', stores } }
}
const build = (version: number, status: KnowledgeBuild['status']): KnowledgeBuild => ({
  id: `build-${version}`,
  baseId: 'docs',
  version,
  status,
  startedAt: now.toISOString(),
  endedAt: now.toISOString(),
  log: ['构建失败，请重试'],
  by,
  stages: [],
})
const run = (
  id: string,
  recall10: number,
  at: string,
  status: KnowledgeEvalRun['status'] = 'done',
): KnowledgeEvalRun => ({
  id,
  baseId: 'docs',
  setId: 'test',
  variants: [{ id: 'one', label: '' }],
  status,
  startedAt: at,
  endedAt: at,
  by,
  perCase: [],
  metrics: { one: { ...metrics([], 'rag'), n: 10, recall10 } },
})
it('最新构建失败产生可去重的 knowledge 风险，后续成功解除', async () => {
  const { space, builds } = await setup()
  builds.push(build(1, 'failed'))
  const risks = await knowledgeRisks(space, now)
  expect(risks).toHaveLength(1)
  expect(risks[0]).toMatchObject({
    key: 'knowledge:space//docs/build',
    kind: 'knowledge',
    level: 'medium',
    evidence: [{ href: '/s/space/knowledge/docs' }],
  })
  builds.push(build(2, 'succeeded'))
  expect(await knowledgeRisks(space, now)).toEqual([])
})
it('stale 立即产生中风险，ready 不报警', async () => {
  const { space, base } = await setup()
  base.status = 'stale'
  base.updatedAt = now.toISOString()
  expect((await knowledgeRisks(space, now))[0]).toMatchObject({ key: 'knowledge:space//docs/stale', level: 'medium', firstSeenAt: base.updatedAt, evidence: [{ href: '/s/space/knowledge/docs' }] })
  base.status = 'ready'
  expect(await knowledgeRisks(space, now)).toEqual([])
})
it('没有构建记录的 error 状态也产生构建失败风险', async () => {
  const { space, base } = await setup()
  base.status = 'error'
  base.error = '索引写入失败'
  expect((await knowledgeRisks(space, now))[0]).toMatchObject({ key: 'knowledge:space//docs/build', detail: '索引写入失败' })
})
it('仅有未发布候选不报过期，源文档变化仍报', async () => {
  const { space, base } = await setup()
  Object.assign(base, { status: 'stale', candidateVersion: 2, staleDocs: 0 })
  expect(await knowledgeRisks(space, now)).toEqual([])
  Object.assign(base, { staleDocs: 1 })
  expect((await knowledgeRisks(space, now))[0]?.key).toBe('knowledge:space//docs/stale')
})
it('最近两次完成评测降幅严格超过 5 个百分点，忽略运行中和失败评测', async () => {
  const { space, runs } = await setup()
  runs.push(
    run('old', 0.8, '2026-11-05'),
    run('new', 0.75, '2026-11-06'),
    run('running', 0, '2026-11-07', 'running'),
    run('failed', 0, '2026-11-07', 'failed'),
  )
  expect(await knowledgeRisks(space, now)).toEqual([])
  runs[1]!.metrics.one!.recall10 = 0.74
  expect((await knowledgeRisks(space, now))[0]?.key).toContain('/recall')
  runs.push(run('recovered', 0.8, '2026-11-07T01:00:00Z'))
  expect(await knowledgeRisks(space, now)).toEqual([])
})
it('七天至少20次查询、无结果率严格大于30%，排除 eval、used、未来及窗口外日志', async () => {
  const { space, stores } = await setup()
  const add = async (
    id: string,
    empty: boolean,
    extra: Partial<Parameters<typeof appendQuery>[1]> = {},
  ) =>
    appendQuery(stores, {
      queryId: id,
      at: now.toISOString(),
      text: id,
      bases: [{ id: 'docs', version: 1 }],
      top: empty ? [] : [{ baseId: 'docs', sourceId: 'docs', ref: 'a', title: '', snippet: '' }],
      latencyMs: 1,
      tokens: 1,
      ...extra,
    })
  for (let index = 0; index < 19; index++) await add(String(index), index < 6)
  for (let index2 = 0; index2 < 25; index2++) await add(`eval-${index2}`, true, { via: 'eval' })
  await add('used', true, { type: 'used' })
  await add('old', true, { at: '2026-10-30' })
  await add('future', true, { at: '2026-11-08' })
  expect(await knowledgeRisks(space, now)).toEqual([])
  await add('20', false)
  expect(await knowledgeRisks(space, now)).toEqual([])
  await add('21', true)
  expect((await knowledgeRisks(space, now))[0]).toMatchObject({
    key: 'knowledge:space//docs/empty',
    detail: expect.stringContaining('21 次查询中 7 次无结果'),
  })
})
it('空间没有知识库时返回空风险', async () => {
  const { stores, space } = await setup()
  delete stores.kb
  expect(await knowledgeRisks(space, now)).toEqual([])
})
