import type { ProjectStores } from '../interfaces.js'
import type { KnowledgeBaseDetail, KnowledgeBaseSummary } from '../api.js'
import { readKnowledgeQueries } from './support.js'
export async function knowledgeUsage(stores: ProjectStores, id: string, now = Date.now()): Promise<{ usage7d: KnowledgeBaseSummary['usage7d']; usage: KnowledgeBaseDetail['usage'] }> {
  const records = await readKnowledgeQueries(stores), used = new Set(records.filter(r => r.type === 'used' && r.top.some(h => h.baseId === id && r.refs?.includes(h.ref))).map(r => r.queryId))
  const queries = records.filter(r => r.type !== 'used' && r.bases.some(b => b.id === id) && Date.parse(r.at) >= now - 7 * 86400000 && Date.parse(r.at) <= now)
  const stats = (rows: typeof queries) => ({ queries: rows.length, hitRate: rows.length ? rows.filter(q => q.top.some(h => h.baseId === id)).length / rows.length : 0, emptyRate: rows.length ? rows.filter(q => !q.top.some(h => h.baseId === id)).length / rows.length : 0, citedRate: rows.length ? rows.filter(q => used.has(q.queryId)).length / rows.length : 0 })
  const trend = Array.from({ length: 7 }, (_, i) => { const date = new Date(now - (6 - i) * 86400000).toISOString().slice(0, 10); return { date, ...stats(queries.filter(q => q.at.slice(0, 10) === date)) } })
  const groups = new Map<string, typeof queries>()
  for (const q of queries) if (q.nodeId) { const key = `${q.workflowId ?? ''}\0${q.nodeId}`; const group = groups.get(key) ?? []; group.push(q); groups.set(key, group) }
  return { usage7d: stats(queries), usage: { trend, byNode: [...groups].map(([key, rows]) => ({ workflowId: key.split('\0')[0]!, nodeId: key.split('\0')[1]!, queries: rows.length, citedRate: stats(rows).citedRate })), recent: queries.slice().sort((a, b) => b.at.localeCompare(a.at)).slice(0, 100).map(q => ({ at: q.at, requirementId: q.requirementId, runId: q.runId, nodeId: q.nodeId, query: q.text, hits: q.top.filter(h => h.baseId === id).length, cited: used.has(q.queryId), latencyMs: q.latencyMs, via: q.via })) } }
}
