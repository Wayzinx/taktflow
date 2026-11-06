import { afterEach, beforeEach, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Lesson, TaktConfig } from '../types.js'
import type { LessonStore } from '../interfaces.js'
import { sha256 } from '../util/hash.js'
import { estimateTokens } from '../util/tokens.js'
import { createLessonStore } from './store.js'
import { createLessonRecall } from './recall.js'
import { pathsIntersect } from './match.js'

let dir: string
let store: LessonStore
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'takt-lessons-recall-')); store = createLessonStore({ dir }) })
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })
const by = { type: 'system', id: 'test' } as const
async function add(id: string, patch: Partial<Lesson> = {}) {
  return store.upsert({ id, title: id, body: '检查实际输入后执行验证', trigger: {}, status: 'tentative', source: { kind: 'judge' }, stats: { recalled: 0, helped: 0, hurt: 0 }, ...patch }, by, 'test')
}
const input = { runId: 'run-1', nodeId: 'dev', role: 'dev', paths: ['src/api/*.ts'], feedback: 'product_bug: Null   input' }
const recall = (config: TaktConfig['lessons'] = {}) => createLessonRecall({ store, config: { holdoutPercent: 0, ...config } })

it('匹配所有已声明触发维度，同维度允许命中任意一项，坏正则不命中', async () => {
  await add('match', { trigger: { roles: ['qa', 'dev'], paths: ['test/**', 'src/**'], signatures: ['other', 'null input'], categories: ['product_bug'] } })
  await add('wrong-role', { trigger: { roles: ['qa'] } })
  await add('wrong-path', { trigger: { paths: ['other/**'] } })
  await add('wrong-category', { trigger: { categories: ['deployment'] } })
  await add('bad-regex', { trigger: { signatures: ['['] } })
  await add('wrong-signature', { trigger: { signatures: ['timeout'] } })
  expect((await recall().recall(input)).lessons.map(item => item.id)).toEqual(['match'])
  expect(pathsIntersect('src/file.ts', 'src/*.ts')).toBe(true)
  expect(pathsIntersect('src/**', 'src/api/*.ts')).toBe(true)
  expect(pathsIntersect('src/**', 'src2/**')).toBe(false)
  expect(pathsIntersect('src/file.ts', 'test/**')).toBe(false)
})

it('启用优先，再按净帮助排序；最多三条，退役不再召回', async () => {
  await add('trial', { stats: { recalled: 50, helped: 50, hurt: 0 } })
  await add('active-low', { status: 'active' })
  await add('active-high', { status: 'active', stats: { recalled: 10, helped: 5, hurt: 1 } })
  await add('retired', { status: 'retired' })
  await add('last')
  expect((await recall().recall(input)).lessons.map(item => item.id)).toEqual(['active-high', 'active-low', 'trial'])
  expect((await recall({ maxRecall: 1 }).recall(input)).lessons).toHaveLength(1)
  expect((await recall({ enabled: false }).recall(input)).lessons).toEqual([])
})

it('预算含标题和分隔符，超预算整条跳过，不注入半条建议', async () => {
  await add('a-long', { body: 'x'.repeat(2500), status: 'active' })
  await add('b-short')
  const result = await recall({ maxTokens: 20 }).recall(input)
  expect(result.lessons.map(item => item.id)).toEqual(['b-short'])
  expect(result.tokens).toBe(estimateTokens(result.text))
  expect(result.tokens).toBeLessThanOrEqual(20)
  expect((await recall({ maxTokens: 0 }).recall(input)).text).toBe('')
})

it('对照分桶按稳定 hash 决定，仅 tentative 被屏蔽', async () => {
  await add('trial')
  const engine = createLessonRecall({ store })
  const expected = Number.parseInt(sha256(input.runId + input.nodeId).slice(0, 8), 16) % 100 < 15
  expect((await engine.recall(input)).holdout).toBe(expected)
  const trialOnly = await recall({ holdoutPercent: 100 }).recall(input)
  expect(trialOnly).toMatchObject({ holdout: true, text: '', tokens: 0 })
  expect(trialOnly.lessons.map(item => item.id)).toEqual(['trial'])
  await add('active', { status: 'active' })
  const mixed = recall({ holdoutPercent: 100 })
  const result = await mixed.recall(input)
  expect(result.holdout).toBe(false)
  expect(result.text).toContain('### active')
  expect(result.text).not.toContain('### trial')
  await mixed.record({ ...input, ids: result.lessons.map(item => item.id), holdout: result.holdout, outcome: 'hurt' })
  expect((await store.get('trial'))?.stats).toEqual({ recalled: 1, helped: 0, hurt: 0 })
  expect((await store.get('active'))?.stats).toEqual({ recalled: 1, helped: 0, hurt: 1 })
})

it('首次执行记一次统计，五次帮助转正，两次坑退役并返回状态变化', async () => {
  await add('trial')
  const engine = recall()
  for (let index = 0; index < 5; index++) {
    const result = await engine.record({ runId: `run-${index}`, nodeId: 'dev', ids: ['trial', 'trial'], holdout: false, outcome: 'helped' })
    expect(result).toHaveLength(index === 4 ? 1 : 0)
  }
  expect((await store.get('trial'))?.status).toBe('active')
  expect((await store.get('trial'))?.stats).toEqual({ recalled: 5, helped: 5, hurt: 0 })
  expect(await engine.record({ runId: 'run-0', nodeId: 'dev', ids: ['trial'], holdout: false, outcome: 'hurt' })).toEqual([])
  await engine.record({ runId: 'bad-1', nodeId: 'dev', ids: ['trial'], holdout: false, outcome: 'hurt' })
  expect(await engine.record({ runId: 'bad-2', nodeId: 'dev', ids: ['trial'], holdout: false, outcome: 'hurt' })).toMatchObject([{ id: 'trial', status: 'retired', stats: { recalled: 7, helped: 5, hurt: 2 } }])
  expect((await engine.recall(input)).lessons).toEqual([])
})

it('对照组失败不记坑，成功仍记帮助；并发 record 不丢统计', async () => {
  await add('trial')
  const engine = recall()
  await engine.record({ ...input, ids: ['trial'], holdout: true, outcome: 'hurt' })
  expect((await store.get('trial'))?.stats).toEqual({ recalled: 1, helped: 0, hurt: 0 })
  await Promise.all([1, 2, 3].map(index => engine.record({ ...input, runId: `other-${index}`, ids: ['trial'], holdout: true, outcome: 'helped' })))
  expect((await store.get('trial'))?.stats).toEqual({ recalled: 4, helped: 3, hurt: 0 })
})
