import { afterEach, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initProject } from '@taktflow/core'
import { appendQuery } from './store/query-log.js'
import { knowledgeUsage } from './usage.js'
const roots: string[] = []
const tz = process.env.TZ
afterEach(async () => {
  process.env.TZ = tz
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
it('使用趋势按本地时区分日：北京时间 11-08 凌晨的查询记在 11-08', async () => {
  process.env.TZ = 'Asia/Shanghai'
  const root = await mkdtemp(join(tmpdir(), 'takt-kb-usage-'))
  roots.push(root)
  const stores = await initProject(root)
  await appendQuery(stores, { queryId: 'q', at: '2026-11-07T18:27:47.699Z', text: '退款规则', bases: [{ id: 'docs', version: 1 }],
    top: [{ baseId: 'docs', sourceId: 'docs', ref: 'refund.md', title: '退款', snippet: '' }], latencyMs: 1, tokens: 0 })
  const { usage } = await knowledgeUsage(stores, 'docs', Date.parse('2026-11-10T04:00:00.000Z'))
  expect(usage.trend.map((day) => day.date)).toEqual(['2026-11-04', '2026-11-05', '2026-11-06', '2026-11-07', '2026-11-08', '2026-11-09', '2026-11-10'])
  expect(usage.trend.find((day) => day.queries)).toMatchObject({ date: '2026-11-08', queries: 1, hitRate: 1 })
})
