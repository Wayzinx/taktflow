import type { KnowledgeStore, ProjectStores } from '../interfaces.js'
import type { KnowledgeBinding, KnowledgeQuery } from '../types.js'
import type { CommandSpec } from './contracts.js'
export function knowledgeCommandSpecs(stores: ProjectStores): CommandSpec[] {
  const kb = (): KnowledgeStore => { if (!stores.kb) throw new Error('知识库未接入，请先初始化 KnowledgeStore'); return stores.kb }
  const define = (id: string, title: string, properties: Record<string, unknown>, required: string[], handler: CommandSpec['handler'], read = false): CommandSpec => ({ id: `knowledge.${id}`, title, kind: read ? 'query' : 'command', risk: read ? 'read' : 'write', minRole: read ? 'viewer' : 'maintainer', input: { type: 'object', properties, required }, handler })
  const text = { type: 'string' }
  return [
    define('create', '新建知识库', { name: text, kind: text, config: { type: 'object' } }, ['name', 'kind', 'config'], async (i, c) => kb().create(i as unknown as Parameters<KnowledgeStore['create']>[0], c.actor, c.reason ?? '')),
    define('update', '更新知识库', { id: text, patch: { type: 'object' } }, ['id', 'patch'], async (i, c) => kb().update(i.id as string, i.patch as Parameters<KnowledgeStore['update']>[1], c.actor, c.reason ?? '')),
    define('build', '构建知识库', { id: text }, ['id'], async (i, c) => kb().build(i.id as string, c.actor, c.reason ?? '')),
    define('publish', '发布知识库', { id: text, version: { type: 'integer' }, force: { type: 'boolean' } }, ['id'], async (i, c) => kb().publish(i.id as string, { version: i.version as number | undefined, force: i.force as boolean | undefined, by: c.actor, reason: c.reason ?? '' })),
    define('bind', '绑定知识库', { bindings: { type: 'array' } }, ['bindings'], async (i, c) => kb().setBindings(i.bindings as KnowledgeBinding[], c.actor, c.reason ?? '')),
    define('query', '查询知识库', { text, intent: text, bases: { type: 'array' } }, ['text'], async (i, c) => kb().route(i as unknown as KnowledgeQuery, { role: c.actor.type === 'agent' ? c.actor.role : undefined }), true),
    define('list', '知识库列表', {}, [], async () => kb().list(), true),
  ]
}
