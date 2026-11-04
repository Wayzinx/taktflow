import type { KnowledgeHit, KnowledgeIntent, KnowledgeQuery, KnowledgeSource } from '@taktflow/core'

function inferIntent(text: string): KnowledgeIntent {
  if (/调用|影响|依赖|impact|caller/i.test(text)) return 'impact'
  if (/表|字段|口径|schema|column/i.test(text)) return 'schema'
  if (/为什么|历史|when|why/i.test(text)) return 'history'
  if (/[._]|[a-z][A-Z]|\(\)/.test(text)) return 'symbol'
  return 'business'
}

export function createKnowledgeRouter(sources: KnowledgeSource[]): {
  route(q: KnowledgeQuery): KnowledgeSource[]
  query(q: KnowledgeQuery): Promise<{ hits: KnowledgeHit[]; sources: string[] }>
} {
  function route(q: KnowledgeQuery): KnowledgeSource[] {
    const intent = q.intent ?? inferIntent(q.text)
    return sources.filter(source => source.intents.includes(intent))
  }
  return {
    route,
    async query(q) {
      const selected = route(q)
      const results = await Promise.all(selected.map(source => source.query(q)))
      const unique = new Map<string, KnowledgeHit>()
      for (const hit of results.flat()) {
        const previous = unique.get(hit.ref)
        if (!previous || (hit.score ?? 0) > (previous.score ?? 0)) {
          unique.set(hit.ref, { ...hit, score: hit.score ?? 0 })
        }
      }
      const hits = [...unique.values()]
        .sort((a, b) => b.score! - a.score!)
        .slice(0, Math.max(0, q.limit ?? 8))
      return { hits, sources: selected.map(source => source.id) }
    },
  }
}
