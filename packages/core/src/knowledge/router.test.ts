import { expect, it } from 'vitest'
import type { KnowledgeIntent, KnowledgeSource } from '../types.js'
import { createKnowledgeRouter } from './router.js'

const source = (id: string, intents: KnowledgeIntent[], score = 1): KnowledgeSource => ({ id, kind: id, intents, describe: () => id,
  query: async () => [{ sourceId: id, title: id, ref: 'same', snippet: id, score }, { sourceId: id, title: id, ref: id, snippet: id, score: 0 }],
})
it('推断 intent，显式 intent 优先，按 ref 去重、分数排序、限制数量', async () => {
  const sources = ['impact', 'schema', 'history', 'symbol', 'business', 'fact'].map((intent) => source(intent, [intent as KnowledgeIntent]))
  const router = createKnowledgeRouter(sources)
  for (const [text, intent] of [['调用链', 'impact'], ['字段口径', 'schema'], ['为什么', 'history'], ['fooBar()', 'symbol'], ['业务规则', 'business']]) {
    expect(router.route({ text: text! }).map((item) => item.id)).toEqual([intent])
  }
  for (const intent of ['fact', 'history', 'symbol'] as const) expect(router.route({ text: '调用链', intent })[0]?.id).toBe(intent)
  const merged = createKnowledgeRouter([source('low', ['business'], 2), source('high', ['business'], 9)])
  expect(await merged.query({ text: '业务', limit: 1 })).toMatchObject({ sources: ['low', 'high'], hits: [{ sourceId: 'high', ref: 'same', score: 9 }] })
  expect((await merged.query({ text: '业务', limit: 0 })).hits).toEqual([])
})
