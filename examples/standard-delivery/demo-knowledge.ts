import assert from 'node:assert/strict'
import { setTimeout } from 'node:timers/promises'
import { attachKnowledge } from '@taktflow/server'
import type { ProjectStores } from '@taktflow/core'

export async function demoKnowledge(stores: ProjectStores): Promise<void> {
  attachKnowledge(stores)
  const kb = stores.kb!, by = { type: 'human', id: 'demo-owner' } as const
  for (const id of ['delivery-docs', 'shop-db']) {
    const started = await kb.build(id, by, '离线知识库演示')
    let build = started
    const deadline = Date.now() + 30000
    while (build.status === 'running' && Date.now() < deadline) { await setTimeout(50); build = (await kb.getBuild(id, build.id))! }
    assert.equal(build.status, 'succeeded', build.log.join('\n'))
    const result = await kb.query(id, { text: id === 'delivery-docs' ? '月份筛选 monthly export' : 'SELECT month, SUM(amount) AS total FROM orders GROUP BY month', intent: id === 'delivery-docs' ? 'business' : 'fact' }, { version: 'candidate', caller: { via: 'playground' } })
    assert(result.hits.length > 0)
    if (id === 'delivery-docs') {
      const started = await kb.runEval(id, { setId: 'smoke', variants: [{ id: 'candidate', label: '候选版本' }], by })
      let run = started
      while (run.status === 'running' && Date.now() < deadline) { await setTimeout(50); run = (await kb.getEvalRun(id, run.id))! }
      assert.equal(run.status, 'done', run.error)
      assert.equal(run.metrics.candidate!.n, 5)
      assert.equal(run.metrics.candidate!.recall10, 1)
      console.log('PASS 知识库评测：5/5，Recall@10=1')
    } else {
      assert(result.hits.some(hit => hit.content?.includes('320')))
    }
    const published = await kb.publish(id, { by, reason: '演示构建、检索与评测通过后发布' })
    assert.equal(published.gate.pass, true, published.gate.reasons.join('\n'))
    assert.equal((await kb.get(id))!.version, 1)
    console.log(`PASS ${id}：构建 → 查询 → 发布 v1`)
  }
}
