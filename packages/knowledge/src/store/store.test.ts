import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, writeFile, readFile, rename, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  openProject,
  readKnowledgeQueries,
  migrateKnowledge,
  type KnowledgeBuild,
  type KnowledgeKind,
} from '@taktflow/core'
import { createKnowledgeStore } from './index.js'
import { createSecretResolver } from './secrets.js'
import { createWikiKind } from '../kinds/llm-wiki.js'
const roots: string[] = []
const by = { type: 'human' as const, id: 'tester' }
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
async function setup(opts: Parameters<typeof createKnowledgeStore>[1] = {}) {
  const root = await mkdtemp(join(tmpdir(), 'takt-kb-'))
  roots.push(root)
  await writeFile(
    join(root, 'takt.config.json'),
    JSON.stringify({ project: { name: 'test' }, workflows: [], paths: { knowledge: 'knowledge' } }),
  )
  const stores = await openProject(root)
  const kb = createKnowledgeStore(stores, opts)
  stores.kb = kb
  return { root, stores, kb }
}
async function built(
  kb: ReturnType<typeof createKnowledgeStore>,
  id: string,
): Promise<KnowledgeBuild> {
  const build2 = await kb.build(id, by, '测试构建')
  for (let index2 = 0; index2 < 200; index2++) {
    const current = (await kb.getBuild(id, build2.id))!
    if (current.status !== 'running') return current
    await new Promise((record) => setTimeout(record, 10))
  }
  throw new Error('构建未结束')
}
it('中英文 BM25、候选与发布隔离、向量增量复用、源哈希和版本保留', async () => {
  const embed = vi.fn(async (texts: string[]) =>
    texts.map((text2) => (text2.includes('退款') ? [1, 0] : [0, 1])),
  )
  const { kb, root } = await setup({ embed })
  await kb.create({ id: 'docs', name: '规则', kind: 'rag', config: {} }, by, '新建')
  await kb.upload(
    'docs',
    [
      { path: 'refund.md', content: '# 退款\n退款规则 refund policy：七天退款。' },
      { path: 'shipping.txt', content: '物流 shipping delivery' },
    ],
    by,
  )
  expect((await built(kb, 'docs')).status).toBe('succeeded')
  expect(
    (await kb.query('docs', { text: '退款规则' }, { version: 'candidate' })).hits[0]?.ref,
  ).toBe('refund.md#0')
  await expect(kb.query('docs', { text: '退款' })).rejects.toThrow('尚未发布')
  await kb.publish('docs', { by, reason: '批准' })
  embed.mockClear()
  expect((await built(kb, 'docs')).status).toBe('succeeded')
  expect(embed).not.toHaveBeenCalled()
  await kb.update('docs', { retrieval: { topK: 0, budgetTokens: 4000 } }, by, '修改草稿')
  expect((await kb.query('docs', { text: '退款' })).hits).toHaveLength(1)
  await writeFile(join(root, 'knowledge/docs/content/refund.md'), '# 退款\n改为三天退款')
  expect(await kb.get('docs')).toMatchObject({ status: 'stale', staleDocs: 1 })
  for (let index3 = 0; index3 < 3; index3++) {
    await built(kb, 'docs')
    await kb.publish('docs', { by, reason: '发布' })
  }
  const { readdir } = await import('node:fs/promises')
  expect(
    (await readdir(join(root, '.takt/knowledge/docs'))).filter((count) => /^v\d+$/.test(count)),
  ).toHaveLength(3)
})
it('索引 manifest 使用相对路径，空间移动后不误判过期且能精确发现单文档变化', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'takt-kb-move-'))
  roots.push(parent)
  const root = join(parent, 'a', 'standard-delivery')
  await mkdir(root, { recursive: true })
  await writeFile(
    join(root, 'takt.config.json'),
    JSON.stringify({ project: { name: 'test' }, space: { id: 'standard-delivery' }, workflows: [], paths: { knowledge: 'knowledge' } }),
  )
  let stores = await openProject(root)
  let kb = createKnowledgeStore(stores)
  stores.kb = kb
  await kb.create({ id: 'docs', name: '规则', kind: 'rag', config: {} }, by, '新建')
  await kb.upload('docs', Array.from({ length: 5 }, (_, i) => ({ path: `doc-${i}.md`, content: `# 文档 ${i}\n内容 ${i}` })), by)
  expect((await built(kb, 'docs')).status).toBe('succeeded')
  await kb.publish('docs', { by, reason: '发布' })
  const manifest = JSON.parse(await readFile(join(root, '.takt/knowledge/docs/v1/index/index.json'), 'utf8')).manifest as Array<{ path: string }>
  expect(manifest).toHaveLength(5)
  expect(manifest.every((source) => !source.path.startsWith('/'))).toBe(true)
  const moved = join(parent, 'b', 'standard-delivery')
  await mkdir(join(parent, 'b'), { recursive: true })
  await rename(root, moved)
  stores = await openProject(moved)
  kb = createKnowledgeStore(stores)
  expect(await kb.get('docs')).toMatchObject({ status: 'ready', staleDocs: 0 })
  await writeFile(join(moved, 'knowledge/docs/content/doc-3.md'), '# 文档 3\n已修改')
  expect(await kb.get('docs')).toMatchObject({ status: 'stale', staleDocs: 1 })
})
it('旧索引中的绝对路径失效后按当前空间根重定位', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'takt-kb-legacy-'))
  roots.push(parent)
  const root = join(parent, 'a', 'standard-delivery')
  await mkdir(root, { recursive: true })
  await writeFile(join(root, 'takt.config.json'), JSON.stringify({ project: { name: 'test' }, space: { id: 'standard-delivery' }, workflows: [], paths: { knowledge: 'knowledge' } }))
  let stores = await openProject(root)
  let kb = createKnowledgeStore(stores)
  await kb.create({ id: 'docs', name: '规则', kind: 'rag', config: {} }, by, '新建')
  await kb.upload('docs', [{ path: 'doc.md', content: '# 文档\n内容' }], by)
  expect((await built(kb, 'docs')).status).toBe('succeeded')
  await kb.publish('docs', { by, reason: '发布' })
  const indexFile = join(root, '.takt/knowledge/docs/v1/index/index.json')
  const index = JSON.parse(await readFile(indexFile, 'utf8'))
  index.manifest = index.manifest.map((source: { path: string; hash: string }) => ({ ...source, path: join(root, source.path) }))
  await writeFile(indexFile, JSON.stringify(index))
  const moved = join(parent, 'b', 'standard-delivery')
  await mkdir(join(parent, 'b'), { recursive: true })
  await rename(root, moved)
  stores = await openProject(moved)
  kb = createKnowledgeStore(stores)
  expect(await kb.get('docs')).toMatchObject({ status: 'ready', staleDocs: 0 })
})
it('无嵌入时中文二元组检索，保留全文与分项分数', async () => {
  const { kb } = await setup()
  await kb.create({ id: 'docs', name: '文档', kind: 'rag', config: {} }, by, '新建')
  await kb.upload(
    'docs',
    [{ path: 'a.md', content: '---\ntitle: 退款\n---\n# 退款规范\n用户可以申请退款' }],
    by,
  )
  await built(kb, 'docs')
  const result = await kb.query('docs', { text: '申请退款' }, { version: 'candidate' })
  expect(result.hits[0]).toMatchObject({
    scores: { bm25: 1 },
    content: expect.stringContaining('用户'),
  })
  expect(result.hits[0]?.snippet).not.toContain('---')
})
it('路由绑定、角色、RRF 优先级、预算、身份留痕', async () => {
  const custom: KnowledgeKind = {
    kind: 'fake',
    title: 'fake',
    summary: '',
    intents: ['business'],
    needsBuild: false,
    configSchema: {},
    test: async () => ({ ok: true, message: '' }),
    query: async (kb) => [
      { sourceId: kb.id, ref: kb.id, title: kb.id, snippet: '12345678', score: 1 },
    ],
  }
  const { kb, stores } = await setup({ kinds: [custom] })
  for (const id of ['a', 'b', 'c']) {
    await kb.create({ id, kind: 'fake', name: id, config: {} }, by, '新建')
    await kb.publish(id, { by, reason: '发布' })
  }
  await kb.setBindings(
    [
      { baseId: 'a', scope: 'space', enabled: true, priority: 5 },
      { baseId: 'b', scope: 'space', enabled: true, priority: 0, roles: ['dev'] },
      { baseId: 'c', scope: 'space', enabled: false, priority: 0 },
    ],
    by,
    '绑定',
  )
  const result = await kb.route(
    { text: '规则' },
    { caller: { runId: 'run', nodeId: 'node', queryId: 'query', role: 'dev', via: 'prefetch' } },
  )
  expect(result.hits.map((hit) => hit.ref)).toEqual(['b', 'a'])
  expect((await kb.route({ text: '规则' }, {})).hits.map((hit2) => hit2.ref)).toEqual(['a'])
  stores.config.knowledgeDefaults = { retrieval: { budgetTokens: 2 } }
  expect((await kb.route({ text: '规则' }, { role: 'dev' })).hits).toHaveLength(1)
  expect((await readKnowledgeQueries(stores))[0]).toMatchObject({
    runId: 'run',
    nodeId: 'node',
    queryId: 'query',
    via: 'prefetch',
  })
})
it('路径穿越、符号链接、明文密钥、无原因写入被拒绝', async () => {
  const { kb, root } = await setup()
  await expect(
    kb.create({ id: '../escape', name: 'x', kind: 'rag', config: {} }, by, 'x'),
  ).rejects.toThrow('ID')
  await expect(kb.create({ name: 'x', kind: 'rag', config: {} }, by, '')).rejects.toThrow('reason')
  await expect(
    kb.create(
      { name: 'db', kind: 'database', config: { driver: 'sqlite', connection: 'plain' } },
      by,
      'x',
    ),
  ).rejects.toThrow('明文')
  await kb.create({ id: 'docs', name: 'x', kind: 'rag', config: {} }, by, 'x')
  await expect(kb.upload('docs', [{ path: '../escape.md', content: 'x' }], by)).rejects.toThrow(
    '路径',
  )
  await mkdir(join(root, 'outside'))
  await symlink(join(root, 'outside'), join(root, 'knowledge/docs/content'))
  await expect(kb.upload('docs', [{ path: 'x.md', content: 'x' }], by)).rejects.toThrow('符号链接')
})
it('Wiki 导航别名优先于段落命中', async () => {
  const { kb } = await setup()
  await kb.create(
    { id: 'wiki', name: 'wiki', kind: 'llm-wiki', config: { source: 'space' } },
    by,
    '新建',
  )
  await kb.upload(
    'wiki',
    [
      { path: 'index.md', content: '# 导航\n[退钱](refund.md)' },
      { path: 'refund.md', content: '---\naliases: [退款]\n---\n# 支付\n支付的规则' },
      { path: 'other.md', content: '# 其他\n退款 退款 退款' },
    ],
    by,
  )
  expect((await built(kb, 'wiki')).status).toBe('succeeded')
  expect((await kb.query('wiki', { text: '退钱' }, { version: 'candidate' })).hits[0]?.ref).toMatch(
    /^refund.md#/,
  )
})
it('迁移预览不写入，应用后绑定并移除旧配置', async () => {
  const { kb, stores, root } = await setup()
  stores.config.knowledge = [{ id: 'old', kind: 'wiki', options: { root: 'docs' } }]
  await writeFile(join(root, 'takt.config.json'), JSON.stringify(stores.config))
  expect(await migrateKnowledge(stores, { dryRun: true }, by)).toMatchObject({
    applied: false,
    items: [{ to: 'llm-wiki' }],
  })
  expect(await kb.list()).toEqual([])
  await migrateKnowledge(stores, { reason: '确认迁移' }, by)
  expect(stores.config.knowledge).toBeUndefined()
  expect(await kb.bindings()).toMatchObject([{ baseId: 'old' }])
})
it('取消构建不会产生候选版本，重启遗留构建失败且有说明', async () => {
  const slow: KnowledgeKind = {
    kind: 'slow',
    title: '',
    summary: '',
    intents: ['business'],
    configSchema: {},
    needsBuild: true,
    test: async () => ({ ok: true, message: '' }),
    query: async () => [],
    build: async (_kb, ctx) => {
      await new Promise((_, reject) =>
        ctx.signal!.addEventListener('abort', () => reject(new Error('abort')), { once: true }),
      )
      return { stats: { docs: 0, chunks: 0, bytes: 0 } }
    },
  }
  const { kb, root } = await setup({ kinds: [slow] })
  await kb.create({ id: 'slow', kind: 'slow', name: 'slow', config: {} }, by, '新建')
  const build = await kb.build('slow', by, '构建')
  await new Promise((record2) => setTimeout(record2, 20))
  expect((await kb.cancelBuild('slow', build.id, by)).status).toBe('cancelled')
  expect(await kb.get('slow')).toMatchObject({ status: 'draft', version: 0 })
  expect((await kb.get('slow'))?.candidateVersion).toBeUndefined()
  await writeFile(
    join(root, `.takt/knowledge/slow/builds/${build.id}.json`),
    JSON.stringify({ ...build, status: 'running' }),
  )
  expect(await kb.getBuild('slow', build.id)).toMatchObject({
    status: 'failed',
    log: ['服务重启中断'],
  })
})
it('W3：取消重建保留已发布及候选版本', async () => {
  let slow = false
  const kind: KnowledgeKind = {
    kind: 'cancel-fixture',
    title: '',
    summary: '',
    intents: ['business'],
    configSchema: {},
    needsBuild: true,
    test: async () => ({ ok: true, message: '' }),
    query: async () => [],
    build: async (_base, context) => {
      if (slow)
        await new Promise((_, reject) =>
          context.signal!.addEventListener('abort', reject, { once: true }),
        )
      return { stats: { docs: 0, chunks: 0, bytes: 0 } }
    },
  }
  const { kb } = await setup({ kinds: [kind] })
  await kb.create({ id: 'cancel', kind: kind.kind, name: 'cancel', config: {} }, by, '新建')
  await built(kb, 'cancel')
  await kb.publish('cancel', { by, reason: '发布' })
  await built(kb, 'cancel')
  const before = await kb.get('cancel')
  slow = true
  const build = await kb.build('cancel', by, '重建')
  await kb.cancelBuild('cancel', build.id, by)
  expect(await kb.get('cancel')).toMatchObject({
    status: before!.status,
    version: 1,
    candidateVersion: 2,
  })
})
it('评测集存取及无效变体拒绝', async () => {
  const { kb } = await setup()
  await kb.create({ id: 'a', name: 'a', kind: 'code', config: {} }, by, '新建')
  await kb.upsertCases(
    'a',
    'manual',
    [{ query: 'foo', relevant: [], source: 'manual', status: 'active', createdBy: by }],
    by,
  )
  expect((await kb.evalSets('a'))[0]?.cases).toHaveLength(1)
  await expect(kb.runEval('a', { setId: 'manual', variants: [], by })).rejects.toThrow(
    '至少一个变体',
  )
  expect((await kb.publish('a', { by, reason: '发布' })).gate.pass).toBe(true)
})
