import type { KnowledgeHit, KnowledgeIntent, KnowledgeQuery, KnowledgeSource } from '@taktflow/core'
import { describe, expect, it, vi } from 'vitest'
import { createKnowledgeRouter } from './router.js'

const intents: KnowledgeIntent[] = ['fact', 'symbol', 'impact', 'business', 'history', 'schema']
function source(
  id: string,
  supported: KnowledgeIntent[],
  hits: KnowledgeHit[] = [],
): KnowledgeSource {
  return { id, kind: id, intents: supported, describe: () => id, query: vi.fn(async () => hits) }
}
function hit(ref: string, score?: number, sourceId = 'one'): KnowledgeHit {
  return { sourceId, title: ref, ref, snippet: ref, score }
}

describe('knowledge router', () => {
  it.each(intents)('显式 %s 优先于推断关键词', (intent) => {
    const sources = intents.map((value) => source(value, [value]))
    expect(
      createKnowledgeRouter(sources)
        .route({ text: '调用字段为什么 someCode()', intent })
        .map((item) => item.id),
    ).toEqual([intent])
  })

  it.each([
    ['调用 foo', 'impact'],
    ['影响范围', 'impact'],
    ['依赖关系', 'impact'],
    ['IMPACT x', 'impact'],
    ['caller', 'impact'],
    ['用户表', 'schema'],
    ['字段', 'schema'],
    ['口径', 'schema'],
    ['SCHEMA', 'schema'],
    ['column', 'schema'],
    ['为什么', 'history'],
    ['历史', 'history'],
    ['WHEN', 'history'],
    ['why', 'history'],
    ['a.b', 'symbol'],
    ['a_b', 'symbol'],
    ['someCode', 'symbol'],
    ['run()', 'symbol'],
    ['支付规则', 'business'],
    ['订单退款', 'business'],
    ['plain word', 'business'],
    ['影响表为什么 a.b', 'impact'],
    ['字段为什么 a.b', 'schema'],
    ['为什么 a.b', 'history'],
  ])('推断 %s → %s', (text, intent) => {
    const sources = intents.map((value) => source(value, [value]))
    expect(
      createKnowledgeRouter(sources)
        .route({ text })
        .map((item) => item.id),
    ).toEqual([intent])
  })

  it('全局 ref 去重保留最高分，缺省 score=0，排序后 limit', async () => {
    const one = source('one', ['symbol'], [hit('same', 1), hit('zero'), hit('negative', -1)])
    const two = source(
      'two',
      ['symbol'],
      [hit('same', 10, 'two'), hit('middle', 5, 'two'), hit('zero', -2, 'two')],
    )
    const router = createKnowledgeRouter([one, two])
    const result = await router.query({ text: 'someCode', limit: 3 })
    expect(result.sources).toEqual(['one', 'two'])
    expect(result.hits.map((item) => [item.ref, item.score, item.sourceId])).toEqual([
      ['same', 10, 'two'],
      ['middle', 5, 'two'],
      ['zero', 0, 'one'],
    ])
    expect((await router.query({ text: 'someCode', limit: 0 })).hits).toEqual([])
  })

  it('默认 8 条，按最高分截断，不提前截断各源或去重前结果', async () => {
    const entries = Array.from({ length: 12 }, (_, index) => hit(`${index}`, index))
    const router = createKnowledgeRouter([source('one', ['business'], [...entries, hit('11', 20)])])
    const result = await router.query({ text: '退款' })
    expect(result.hits.map((item) => item.ref)).toEqual(['11', '10', '9', '8', '7', '6', '5', '4'])
  })

  it('Promise.all 并发且原样透传 scope 和完整 query', async () => {
    const releases: Array<() => void> = []
    const selected = ['one', 'two'].map((id) => ({
      ...source(id, ['history']),
      query: vi.fn(
        (_q: KnowledgeQuery) =>
          new Promise<KnowledgeHit[]>((resolve) => {
            releases.push(() => resolve([]))
          }),
      ),
    }))
    const query2: KnowledgeQuery = { text: 'why', scope: ['src', 'REQ-1'], limit: 4 }
    const pending = createKnowledgeRouter(selected).query(query2)
    expect(releases).toHaveLength(2)
    for (const item of selected) expect(item.query.mock.calls[0]?.[0]).toBe(query2)
    releases.forEach((release) => release())
    expect(await pending).toEqual({ hits: [], sources: ['one', 'two'] })
  })

  it('无匹配源返回空结果，源失败向上传播', async () => {
    expect(await createKnowledgeRouter([]).query({ text: 'hello' })).toEqual({
      hits: [],
      sources: [],
    })
    const failing = source('failure', ['fact'])
    failing.query = async () => {
      throw new Error('source unavailable')
    }
    await expect(
      createKnowledgeRouter([failing]).query({ text: 'x', intent: 'fact' }),
    ).rejects.toThrow('source unavailable')
  })
})
