import { afterEach, expect, it } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm, appendFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { initProject } from '../store/project.js'
import { createEngine } from './index.js'
import type { AgentProfile, HarnessAdapter } from '../types.js'
import { agent, defineWorkflow } from '../dsl.js'
import { createKnowledgeStore } from '../../../knowledge/src/store/index.js'
import { readKnowledgeQueries } from '../knowledge/support.js'
const roots: string[] = []
afterEach(async () => { for (const r of roots.splice(0)) await rm(r, { recursive: true, force: true }) })
it('知识库预取身份、上下文文件、工具提示和 knowledge.used 留痕', async () => {
  const root = await mkdtemp(join(tmpdir(), 'takt-engine-kb-')); roots.push(root)
  const stores = await initProject(root, { layout: 'space' }), by = { type: 'human' as const, id: 'test' }
  const kind: import('../interfaces.js').KnowledgeKind = { kind: 'fixture', title: '', summary: '', intents: ['business'], needsBuild: false, configSchema: {}, test: async () => ({ ok: true, message: '' }), query: async () => [{ sourceId: 'docs', ref: 'refund.md#0', title: '退款', snippet: '七天退款', score: 1 }] }
  stores.kb = createKnowledgeStore(stores, { kinds: [kind] })
  await stores.kb.create({ id: 'docs', name: '规则', kind: 'fixture', config: {} }, by, '新建')
  await stores.kb.publish('docs', { by, reason: '发布' })
  await stores.kb.setBindings([{ baseId: 'docs', scope: 'space', enabled: true, priority: 0 }], by, '绑定')
  await appendFile(join(stores.taktDir, 'knowledge/queries.jsonl'), '{broken\n')
  const req = await stores.workspaces.createRequirement({ title: '知识测试' })
  let prompt = '', nodeId = ''
  const harness: HarnessAdapter = { id: 'mock', displayName: 'mock', available: async () => ({ ok: true }), async run(request) {
    prompt = request.prompt; nodeId = request.env!.TAKT_NODE_ID!
    await mkdir(join(request.env!.TAKT_WORKSPACE!, 'reports'), { recursive: true })
    await writeFile(join(request.env!.TAKT_WORKSPACE!, 'reports/result.md'), '根据 refund.md#0：七天退款')
    return { ok: true, finalText: '完成' }
  } }
  const profile: AgentProfile = { role: 'dev', title: 'dev', description: '', instructions: '', skills: [], writeScope: ['**'], harness: { harness: 'mock' } }
  const workflow = defineWorkflow({ id: 'kb-test', title: 'kb', version: '1', stages: [], nodes: [agent({ id: 'work', title: '工作', role: 'dev', prompt: '查询规则', outputs: [{ path: 'reports/result.md', kind: 'report' }], knowledge: { bases: ['docs'], prefetch: [{ text: '退款规则' }], mode: 'both' } })] })
  const run = await createEngine({ stores, knowledge: [], profiles: { dev: profile }, harnesses: { mock: harness } }).start({ workflow, requirementId: req.id })
  expect(run.status).toBe('succeeded')
  expect(nodeId).toBe('work'); expect(prompt).toContain('takt kb query'); expect(prompt).toContain('context/knowledge')
  const events = await stores.events.read(run.runId)
  expect(events.find(e => e.type === 'knowledge.query')?.data).toMatchObject({ via: 'prefetch', bases: [{ id: 'docs', version: 1 }], hits: 1, tokens: 1 })
  expect(events.find(e => e.type === 'knowledge.used')?.data).toMatchObject({ refs: ['refund.md#0'], artifact: { workspace: req.id, path: 'reports/result.md', version: run.nodes.work!.outputs[0]!.version } })
  expect((await readKnowledgeQueries(stores)).filter(q => q.type === 'used')).toHaveLength(1)
})

it('挂上空知识库存储后，未迁移的旧知识源继续预取', async () => {
  const root = await mkdtemp(join(tmpdir(), 'takt-engine-legacy-kb-')); roots.push(root)
  const stores = await initProject(root, { layout: 'space' })
  stores.kb = createKnowledgeStore(stores)
  const req = await stores.workspaces.createRequirement({ title: '旧 Wiki 兼容' })
  let prompt = ''
  const harness: HarnessAdapter = { id: 'mock', displayName: 'mock', available: async () => ({ ok: true }), async run(request) { prompt = request.prompt; return { ok: true, finalText: '完成' } } }
  const profile: AgentProfile = { role: 'dev', title: 'dev', description: '', instructions: '', skills: [], writeScope: ['**'], harness: { harness: 'mock' } }
  const workflow = defineWorkflow({ id: 'legacy-kb', title: '旧知识源', version: '1', stages: [], nodes: [agent({ id: 'work', title: '查询', role: 'dev', prompt: '查询退款规则', knowledge: [{ text: '退款规则', intent: 'business' }] })] })
  const run = await createEngine({ stores, profiles: { dev: profile }, harnesses: { mock: harness }, knowledge: [{ id: 'legacy-wiki', kind: 'wiki', describe: () => '旧 Wiki', intents: ['business'], query: async () => [{ sourceId: 'legacy-wiki', ref: 'refund.md', title: '退款', snippet: '旧 Wiki 七天退款' }] }] }).start({ workflow, requirementId: req.id })
  expect(run.status).toBe('succeeded')
  expect(prompt).toContain('旧 Wiki 七天退款')
  expect((await stores.events.read(run.runId)).find(e => e.type === 'knowledge.query')?.data).toMatchObject({ sources: ['legacy-wiki'], hits: 1 })
})

it.each([
  { node: ['node'], role: ['role'], expected: ['node'] },
  { node: undefined, role: ['role'], expected: ['role'] },
  { node: undefined, role: undefined, expected: ['node', 'role', 'space'] },
  { node: undefined, role: [], expected: [] },
])('知识选择优先级 节点 $node > 角色 $role > 空间', async ({ node, role, expected }) => {
  const root = await mkdtemp(join(tmpdir(), 'takt-role-kb-')); roots.push(root)
  const stores = await initProject(root), by = { type: 'human' as const, id: 'test' }
  const kind: import('../interfaces.js').KnowledgeKind = { kind: 'fixture', title: '', summary: '', intents: ['business'], needsBuild: false, configSchema: {}, test: async () => ({ ok: true, message: '' }), query: async kb => [{ sourceId: kb.id, ref: kb.id, title: kb.id, snippet: kb.id }] }
  stores.kb = createKnowledgeStore(stores, { kinds: [kind] })
  for (const id of ['node', 'role', 'space']) { await stores.kb.create({ id, name: id, kind: 'fixture', config: {} }, by, '创建'); await stores.kb.publish(id, { by, reason: '发布' }) }
  await stores.kb.setBindings(['node', 'role', 'space'].map(baseId => ({ baseId, scope: 'space' as const, enabled: true, priority: 0 })), by, '绑定')
  const req = await stores.workspaces.createRequirement({ title: '优先级' })
  let prompt = ''
  const harness: HarnessAdapter = { id: 'mock', displayName: 'mock', available: async () => ({ ok: true }), run: async input => { prompt = input.prompt; return { ok: true, finalText: '完成' } } }
  const profile: AgentProfile = { role: 'dev', title: '开发', description: '', instructions: '', skills: [], writeScope: [], harness: { harness: 'mock' }, knowledge: role }
  const workflow = defineWorkflow({ id: 'priority', title: '优先级', version: '1', stages: [], nodes: [agent({ id: 'work', title: '查询', role: 'dev', prompt: '查询', knowledge: { bases: node, prefetch: [{ text: 'query', intent: 'business' }] } })] })
  const run = await createEngine({ stores, profiles: { dev: profile }, harnesses: { mock: harness }, knowledge: [] }).start({ workflow, requirementId: req.id })
  expect(run.status).toBe('succeeded')
  const event = (await stores.events.read(run.runId)).find(e => e.type === 'knowledge.query')!
  expect((event.data as { bases: Array<{ id: string }> }).bases.map(b => b.id).sort()).toEqual(expected)
  for (const id of ['node', 'role', 'space']) expect(prompt.includes(`${id} — ${id}`)).toBe(expected.includes(id))
})
