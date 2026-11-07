import type {
  Actor,
  KnowledgeBase,
  KnowledgeEvalRun,
  KnowledgeQuery,
  KnowledgeRetrieval,
  KnowledgeStore,
} from '@taktflow/core'
import type { Chunk } from '../kinds/search.js'
import type { QueryRecord } from '../store/query-log.js'

export interface EvalDeps {
  store: KnowledgeStore
  chat?: (prompt: string) => Promise<string>
  query(
    id: string,
    query: KnowledgeQuery,
    version: number,
    retrieval: Partial<KnowledgeRetrieval>,
  ): ReturnType<KnowledgeStore['query']>
  snapshot(id: string, version: number): Promise<{ base: KnowledgeBase; chunks: Chunk[] }>
  saveRun(run: KnowledgeEvalRun): Promise<void>
  queries(): Promise<QueryRecord[]>
  audit(by: Actor, reason: string, message: string): Promise<void>
}
