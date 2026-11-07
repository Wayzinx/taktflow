import { expect, it, vi } from 'vitest'
import { knowledgeCommandSpecs } from './knowledge-commands.js'
import { createCommandRegistry } from './index.js'
import type { KnowledgeStore, ProjectStores } from '../interfaces.js'
it('七条命令可注册，写操作要求原因与 maintainer，查询不要求原因', async () => {
  const list = vi.fn(async () => []), create = vi.fn(async () => ({ id: 'created' }))
  const kb = { list, create } as unknown as KnowledgeStore
  const stores = { config: { members: [{ id: 'owner', role: 'owner' }, { id: 'viewer', role: 'viewer' }] }, kb } as unknown as ProjectStores
  const registry = createCommandRegistry({ stores, audit: async () => {}, extensions: knowledgeCommandSpecs(stores) })
  expect(registry.list().filter(s => s.id.startsWith('knowledge.'))).toHaveLength(7)
  const input = { name: 'docs', kind: 'rag', config: {} }
  expect(await registry.run('knowledge.create', input, { actor: { type: 'human', id: 'owner' } })).toMatchObject({ ok: false })
  expect(await registry.run('knowledge.create', input, { actor: { type: 'human', id: 'viewer' }, reason: 'test' })).toMatchObject({ ok: false })
  expect(create).not.toHaveBeenCalled()
  expect(await registry.run('knowledge.create', input, { actor: { type: 'human', id: 'owner' }, reason: 'test' })).toMatchObject({ ok: true, result: { id: 'created' } })
  expect(await registry.run('knowledge.list', {}, { actor: { type: 'human', id: 'viewer' } })).toMatchObject({ ok: true, result: [] })
})
