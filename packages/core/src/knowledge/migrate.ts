import { relative, isAbsolute } from 'node:path'
import type { Actor } from '../types.js'
import type { ProjectStores } from '../interfaces.js'
import type { KnowledgeMigration } from '../api.js'
import { changeKnowledgeConfig } from './support.js'
export async function migrateKnowledge(stores: ProjectStores, input: { dryRun?: boolean; reason?: string }, by: Actor): Promise<KnowledgeMigration> {
  if (!stores.kb) throw new Error('知识库未接入，请先初始化 KnowledgeStore')
  const mapping: Record<string, string> = { wiki: 'llm-wiki', grep: 'code', 'git-history': 'history', workspace: 'history', database: 'database', 'api-registry': 'api' }
  const legacy = stores.config.knowledge ?? [], existing = await stores.kb.list()
  const items = legacy.map(source => ({ id: source.id, kind: source.kind, to: mapping[source.kind], ok: !!mapping[source.kind] && !existing.some(k => k.id === source.id), message: !mapping[source.kind] ? '类型不支持，请手工登记' : existing.some(k => k.id === source.id) ? 'ID 已存在，请先解决冲突' : ['database', 'api-registry'].includes(source.kind) ? '迁移为草稿，请补齐连接和允许列表' : '将创建知识库并绑定' }))
  if (input.dryRun) return { items, applied: false }
  if (!input.reason?.trim()) throw new Error('应用迁移必须提供 reason，请先预览并说明原因')
  if (items.some(i => !i.ok)) return { items, applied: false }
  const bindings = await stores.kb.bindings()
  const created: string[] = []
  try {
    for (const source of legacy) {
      const options = source.options ?? {}, pathValue = String(options.root ?? options.path ?? options.wikiDir ?? (source.kind === 'wiki' ? 'docs/wiki' : '.'))
      const path = isAbsolute(pathValue) ? relative(stores.projectDir, pathValue) : pathValue
      if (path.split('/').includes('..')) throw new Error('旧知识源指向空间外，请先将数据源移入空间')
      const config = source.kind === 'wiki' ? { source: 'path', path } : source.kind === 'grep' ? { path, ...(options.ignore ? { ignore: options.ignore } : {}) } : ['git-history', 'workspace'].includes(source.kind) ? { source: source.kind, path, ...(source.kind === 'workspace' && options.taktDir ? { workspacePath: isAbsolute(String(options.taktDir)) ? relative(stores.projectDir, String(options.taktDir)) : String(options.taktDir) } : {}) } : source.kind === 'database' ? { driver: options.driver ?? 'sqlite', connection: '${env:TAKT_KB_DATABASE_URL}' } : { openapi: options.openapi ?? '', allow: [] }
      const kb = await stores.kb.create({ id: source.id, name: source.id, kind: mapping[source.kind]!, config }, by, input.reason)
      created.push(kb.id); bindings.push({ baseId: kb.id, scope: kb.scope, enabled: true, priority: bindings.length })
    }
    await changeKnowledgeConfig(stores, by, input.reason, 'knowledge.migrate', config => {
      const current = config.knowledge ?? []
      if (JSON.stringify(current) !== JSON.stringify(legacy)) throw new Error('旧知识源已发生变化，请重新预览迁移')
      config.knowledgeBindings = bindings; delete config.knowledge
    })
  } catch (error) {
    for (const id of created.reverse()) await stores.kb.remove(id, by, '回滚未完成的知识源迁移')
    throw error
  }
  return { items, applied: true }
}
