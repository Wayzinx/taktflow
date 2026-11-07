import type { ProjectStores } from '@taktflow/core'
import type { KnowledgeBaseDetail, KnowledgeBaseSummary } from '@taktflow/core'
import { readQueries } from './store/query-log.js'
export async function knowledgeUsage(
  stores: ProjectStores,
  id: string,
  now = Date.now(),
): Promise<{ usage7d: KnowledgeBaseSummary['usage7d']; usage: KnowledgeBaseDetail['usage'] }> {
  const records = await readQueries(stores)
  const used = new Set(
    records
      .filter(
        (query2) =>
          query2.type === 'used' &&
          records.some(
            (query) =>
              query.type !== 'used' &&
              query.queryId === query2.queryId &&
              query.top.some((hit) => hit.baseId === id && query2.refs?.includes(hit.ref)),
          ),
      )
      .map((query3) => query3.queryId),
  )
  const queries = records.filter(
    (query4) =>
      query4.type !== 'used' &&
      query4.via !== 'eval' &&
      query4.bases.some((right) => right.id === id) &&
      Date.parse(query4.at) >= now - 7 * 86400000 &&
      Date.parse(query4.at) <= now,
  )
  const stats = (rows: typeof queries) => ({
    queries: rows.length,
    hitRate: rows.length
      ? rows.filter((query5) => query5.top.some((hit2) => hit2.baseId === id)).length / rows.length
      : 0,
    emptyRate: rows.length
      ? rows.filter((query6) => !query6.top.some((hit3) => hit3.baseId === id)).length / rows.length
      : 0,
    citedRate: rows.length
      ? rows.filter((query7) => used.has(query7.queryId)).length / rows.length
      : 0,
  })
  const trend = Array.from({ length: 7 }, (_, index) => {
    const date = new Date(now - (6 - index) * 86400000).toISOString().slice(0, 10)
    return { date, ...stats(queries.filter((query8) => query8.at.slice(0, 10) === date)) }
  })
  const workflows = new Map<string, string>()
  for (const query9 of queries)
    if (query9.runId && !query9.workflowId) {
      if (!workflows.has(query9.runId))
        workflows.set(query9.runId, (await stores.runs.get(query9.runId))?.workflowId ?? '')
      query9.workflowId = workflows.get(query9.runId)
    }
  const groups = new Map<string, typeof queries>()
  for (const query10 of queries)
    if (query10.nodeId) {
      const key = `${query10.workflowId ?? ''}\0${query10.nodeId}`
      const group = groups.get(key) ?? []
      group.push(query10)
      groups.set(key, group)
    }
  return {
    usage7d: stats(queries),
    usage: {
      trend,
      byNode: [...groups].map(([key, rows]) => ({
        workflowId: key.split('\0')[0]!,
        nodeId: key.split('\0')[1]!,
        queries: rows.length,
        citedRate: stats(rows).citedRate,
      })),
      recent: queries
        .slice()
        .sort((query11, query12) => query12.at.localeCompare(query11.at))
        .slice(0, 100)
        .map((query13) => ({
          at: query13.at,
          requirementId: query13.requirementId,
          runId: query13.runId,
          nodeId: query13.nodeId,
          query: query13.text,
          hits: query13.top.filter((hit4) => hit4.baseId === id).length,
          cited: used.has(query13.queryId),
          latencyMs: query13.latencyMs,
          via: query13.via === 'prefetch' || query13.via === 'tool' ? query13.via : undefined,
        })),
    },
  }
}
