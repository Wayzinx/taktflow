import { expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initProject } from '../store/project.js'
import { appendKnowledgeQuery } from './support.js'
import { knowledgeUsage } from './usage.js'
it('七天趋势按库计算引用率，过期查询不计入', async () => {
  const root = await mkdtemp(join(tmpdir(), 'takt-usage-'))
  try {
    const stores = await initProject(root), now = Date.now(), record = { queryId: 'q', at: new Date(now).toISOString(), workflowId: 'wf', nodeId: 'node', text: '规则', bases: [{ id: 'a', version: 1 }, { id: 'b', version: 1 }], top: [{ baseId: 'a', sourceId: 'a', ref: 'a', title: 'a', snippet: '' }, { baseId: 'b', sourceId: 'b', ref: 'b', title: 'b', snippet: '' }], latencyMs: 1, tokens: 0 }
    await appendKnowledgeQuery(stores, record)
    await appendKnowledgeQuery(stores, { ...record, type: 'used', refs: ['a'] })
    await appendKnowledgeQuery(stores, { ...record, queryId: 'old', at: new Date(now - 8 * 86400000).toISOString() })
    expect((await knowledgeUsage(stores, 'a', now)).usage7d).toMatchObject({ queries: 1, citedRate: 1 })
    const other = await knowledgeUsage(stores, 'b', now)
    expect(other.usage7d).toMatchObject({ queries: 1, citedRate: 0, hitRate: 1 })
    expect(other.usage.trend).toHaveLength(7)
    expect(other.usage.byNode).toEqual([{ workflowId: 'wf', nodeId: 'node', queries: 1, citedRate: 0 }])
  } finally { await rm(root, { recursive: true, force: true }) }
})
