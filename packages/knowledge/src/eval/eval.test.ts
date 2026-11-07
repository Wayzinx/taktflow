import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openProject, type KnowledgeEvalCase, type KnowledgeKind } from '@taktflow/core'
import { createKnowledgeStore, type KnowledgeStoreOptions } from '../store/index.js'
import { makeIndex, saveIndex, trimHits } from '../kinds/search.js'
import { appendQuery, readQueries } from '../store/query-log.js'
import { knowledgeUsage } from '../usage.js'
import { knowledgeRisks } from '../risks.js'
const roots: string[] = []
const by = { type: 'human' as const, id: 'tester' }
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
const fixture: KnowledgeKind = {
  kind: 'fixture',
  title: '夹具',
  summary: '',
  intents: ['business'],
  needsBuild: true,
  configSchema: {},
  test: async () => ({ ok: true, message: '' }),
  async build(kb, ctx) {
    const refs = (kb.config.refs as string[]) ?? ['a', 'b']
    await saveIndex(
      ctx.indexDir,
      makeIndex(refs.map((ref) => ({ ref, title: ref, content: `文档 ${ref}`, hash: ref }))),
    )
    return { stats: { docs: refs.length, chunks: refs.length, bytes: 10 } }
  },
  async query(kb, query2, _ctx, retrieval) {
    if (query2.text === 'error') throw new Error('测试检索错误')
    const refs = (kb.config.ranks as Record<string, string[]> | undefined)?.[query2.text] ?? ['a']
    return trimHits(
      refs.map((ref) => ({
        ref,
        sourceId: kb.id,
        title: ref,
        snippet: `内容 ${ref}`,
        score: ref === 'filtered' ? 0.01 : 1,
      })),
      retrieval,
    )
  },
}
async function setup(config: Record<string, unknown> = {}, options: KnowledgeStoreOptions = {}) {
  const root = await mkdtemp(join(tmpdir(), 'takt-eval-'))
  roots.push(root)
  await writeFile(
    join(root, 'takt.config.json'),
    JSON.stringify({ project: { name: 'eval' }, workflows: [] }),
  )
  const stores = await openProject(root)
  const kb = createKnowledgeStore(stores, { kinds: [fixture], ...options })
  stores.kb = kb
  await kb.create(
    {
      id: 'docs',
      name: '文档',
      kind: 'fixture',
      config,
      retrieval: { topK: 10, budgetTokens: 4000 },
    },
    by,
    '新建',
  )
  const build = async () => {
    const task = await kb.build('docs', by, '构建')
    await vi.waitFor(async () =>
      expect((await kb.getBuild('docs', task.id))?.status).toBe('succeeded'),
    )
  }
  await build()
  await kb.publish('docs', { by, reason: '首次发布' })
  return { root, stores, kb, build }
}
const testCase = (id: string, ref = 'a', extra: Partial<KnowledgeEvalCase> = {}) => ({
  id,
  query: id,
  relevant: [{ ref, grade: 3 as const }],
  source: 'manual' as const,
  status: 'active' as const,
  createdBy: by,
  ...extra,
})
async function done(kb: ReturnType<typeof createKnowledgeStore>, runId: string) {
  await vi.waitFor(async () =>
    expect((await kb.getEvalRun('docs', runId))?.status).not.toBe('running'),
  )
  return (await kb.getEvalRun('docs', runId))!
}
it('后台运行、四类诊断、active 过滤、指定版本与参数覆盖、成对比较及落盘回读', async () => {
  const { kb, root, stores, build } = await setup({
    refs: ['a', 'b'],
    ranks: { ok: ['a'], low: ['x', 'a'], missing: [], absent: [] },
  })
  await kb.upsertCases(
    'docs',
    'manual',
    [
      testCase('ok'),
      testCase('low'),
      testCase('missing', 'b'),
      testCase('absent', 'z'),
      testCase('skip', 'a', { status: 'candidate' }),
    ],
    by,
  )
  await kb.update(
    'docs',
    {
      config: {
        refs: ['a', 'b', 'z'],
        ranks: { ok: ['a'], low: ['a'], missing: ['b'], absent: ['z'] },
      },
    },
    by,
    '改进',
  )
  await build()
  const run = await kb.runEval('docs', {
    setId: 'manual',
    variants: [
      { id: 'old', label: '旧', version: 1, retrieval: { topK: 1 } },
      { id: 'new', label: '新', retrieval: { topK: 1 } },
    ],
    by,
  })
  expect(run.status).toBe('running')
  expect(run.variants.map((value) => value.version)).toEqual([1, 2])
  const result = await done(kb, run.id)
  expect(result.status).toBe('done')
  expect(result.perCase).toHaveLength(8)
  expect(
    result.perCase.filter((chunk) => chunk.variant === 'old').map((chunk2) => chunk2.diagnosis),
  ).toEqual(['ok', 'low_rank', 'not_retrieved', 'no_doc'])
  expect(result.perCase[1]).toMatchObject({ firstRelevantRank: 2, found: [], missed: ['a'] })
  expect(result.metrics.old).toMatchObject({ n: 4, recall10: 0.25 })
  expect(result.metrics.new).toMatchObject({ n: 4, recall10: 1 })
  expect(result.comparison).toMatchObject({ wins: 3, ties: 1, losses: 0, verdict: 'inconclusive' })
  expect(
    JSON.parse(
      await readFile(join(root, `.takt/knowledge/docs/evals/runs/${run.id}.json`), 'utf8'),
    ),
  ).toEqual(result)
  expect((await readQueries(stores)).every((query3) => query3.via === 'eval')).toBe(true)
  expect((await knowledgeUsage(stores, 'docs')).usage7d.queries).toBe(0)
  expect((await kb.evalRuns('docs')).map((record) => record.id)).toContain(run.id)
})
it('索引存在但超过 50 名为 not_retrieved，预算截断不算 topK 命中', async () => {
  const { kb } = await setup({
    refs: ['a'],
    ranks: {
      deep: [...Array.from({ length: 50 }, (_, index2) => `x${index2}`), 'a'],
      budget: ['a'],
    },
  })
  await kb.upsertCases('docs', 'manual', [testCase('deep'), testCase('budget')], by)
  const run = await kb.runEval('docs', {
    setId: 'manual',
    variants: [{ id: 'one', label: '', retrieval: { topK: 1, budgetTokens: 0 } }],
    by,
  })
  const result = await done(kb, run.id)
  expect(result.perCase[0]?.diagnosis).toBe('not_retrieved')
  expect(result.perCase[1]).toMatchObject({ found: [], diagnosis: 'low_rank' })
  expect(result.metrics.one).toMatchObject({ emptyRate: 1, tokensPerQuery: 0, recall10: 0 })
})
it('检索失败写终态与错误，参数和路径在启动前拒绝', async () => {
  const { kb } = await setup()
  await kb.upsertCases('docs', 'manual', [testCase('error')], by)
  const run = await kb.runEval('docs', {
    setId: 'manual',
    variants: [{ id: 'one', label: '' }],
    by,
  })
  expect(await done(kb, run.id)).toMatchObject({
    status: 'failed',
    endedAt: expect.any(String),
    error: expect.stringContaining('测试检索错误'),
  })
  for (const setId of ['../escape', 'unknown'])
    await expect(kb.runEval('docs', { setId, variants: [], by })).rejects.toThrow()
  await expect(
    kb.runEval('docs', { setId: 'manual', variants: [{ id: 'one', label: '', version: 99 }], by }),
  ).rejects.toThrow('索引')
  await expect(
    kb.runEval('docs', {
      setId: 'manual',
      variants: [{ id: 'one', label: '', retrieval: { topK: -1 } }],
      by,
    }),
  ).rejects.toThrow('参数')
  await expect(kb.getEvalRun('docs', '../escape')).rejects.toThrow('ID')
})
it('发布门槛覆盖全部集合：回退超过阈值且显著 worse 被拒绝；force 需原因并审计，保留失败门槛', async () => {
  const { kb, stores, root, build } = await setup()
  await kb.upsertCases(
    'docs',
    'manual',
    Array.from({ length: 6 }, (_, index3) => testCase(`q${index3}`)),
    by,
  )
  await kb.upsertCases('docs', 'defects', [testCase('q0', 'a', { source: 'defect' })], by)
  await kb.update(
    'docs',
    {
      config: {
        ranks: Object.fromEntries(Array.from({ length: 6 }, (_, index4) => [`q${index4}`, []])),
      },
    },
    by,
    '候选变更',
  )
  await build()
  const rejected = await kb.publish('docs', { by, reason: '验证门槛' })
  expect(rejected.base.version).toBe(1)
  expect(rejected.gate.pass).toBe(false)
  expect(rejected.gate.reasons.join(' ')).toMatch(/5 个百分点.*显著退化.*defects\/q0/)
  expect((await kb.evalRuns('docs'))[0]?.perCase).toHaveLength(14)
  await expect(kb.publish('docs', { by, reason: ' ', force: true })).rejects.toThrow('reason')
  const forced = await kb.publish('docs', { by, reason: '已确认影响，强制发布', force: true })
  expect(forced).toMatchObject({ base: { version: 2 }, gate: { pass: false } })
  const audit = await readFile(join(stores.taktDir, 'space-events.jsonl'), 'utf8')
  expect(audit).toContain('knowledge.publish.force:docs:')
  expect(audit).toContain('已确认影响，强制发布')
  expect(audit).toContain('defects/q0')
  expect(JSON.parse(await readFile(join(root, 'knowledge/docs/kb.json'), 'utf8')).version).toBe(2)
})
it('恰好下降 5 个百分点允许，超过阈值即使不显著也拒绝', async () => {
  const { kb, build } = await setup()
  await kb.upsertCases(
    'docs',
    'set',
    Array.from({ length: 20 }, (_, index5) => testCase(`q${index5}`)),
    by,
  )
  await kb.update('docs', { config: { ranks: { q0: [] } } }, by, '单条下降')
  await build()
  expect((await kb.publish('docs', { by, reason: '验证边界' })).gate.pass).toBe(true)
  await kb.update('docs', { config: { ranks: { q0: [], q1: [], q2: [] } } }, by, '再降两条')
  await build()
  const result = await kb.publish('docs', { by, reason: '验证回退' })
  expect(result.gate.pass).toBe(false)
  expect(result.gate.reasons).toHaveLength(1)
})
it('无 active 用例直接通过；首次发布仍要求 defect 在 topK 命中', async () => {
  const { kb } = await setup()
  expect((await kb.publish('docs', { by, reason: '再发布', version: 1 })).gate).toEqual({
    pass: true,
    reasons: ['无评测用例，首次发布'],
  })
  await kb.create(
    { id: 'new', name: '首次', kind: 'fixture', config: { ranks: { q: [] } } },
    by,
    '新建',
  )
  const build = await kb.build('new', by, '构建')
  await vi.waitFor(async () =>
    expect((await kb.getBuild('new', build.id))?.status).toBe('succeeded'),
  )
  await kb.upsertCases('new', 'defects', [testCase('q', 'a', { source: 'defect' })], by)
  expect((await kb.publish('new', { by, reason: '首发' })).gate.pass).toBe(false)
})
it('指定保留版本发布不会误测最新候选，历史快照与在线查询隔离', async () => {
  const { kb, build } = await setup()
  await kb.upsertCases('docs', 'set', [testCase('q', 'a', { source: 'defect' })], by)
  await kb.update('docs', { config: { ranks: { q: [] } } }, by, '损坏候选')
  await build()
  expect((await kb.publish('docs', { by, reason: '保留旧版本', version: 1 })).gate.pass).toBe(true)
  expect((await kb.get('docs'))?.candidateVersion).toBe(2)
})
it('假 chat 从已发布文档块合成，每块最多两题，候选不会进入发布门槛', async () => {
  const chat = vi.fn(async (prompt: string) => {
    const ref = JSON.parse(prompt.slice(prompt.indexOf('{'))).ref
    return JSON.stringify([`${ref} 问题一`, `${ref} 问题二`])
  })
  const { kb } = await setup({ refs: ['a', 'b', 'c'] }, { chat })
  const cases = await kb.synthesizeCases('docs', 'generated', 5, by)
  expect(cases).toHaveLength(5)
  expect(chat).toHaveBeenCalledTimes(3)
  expect(
    cases.every(
      (evalCase) =>
        evalCase.source === 'synthetic' &&
        evalCase.status === 'candidate' &&
        evalCase.relevant[0]?.grade === 3,
    ),
  ).toBe(true)
  expect(
    Math.max(
      ...['a', 'b', 'c'].map(
        (ref) => cases.filter((evalCase2) => evalCase2.relevant[0]?.ref === ref).length,
      ),
    ),
  ).toBeLessThanOrEqual(2)
  expect((await kb.publish('docs', { by, reason: '发布', version: 1 })).gate.reasons).toEqual([
    '无评测用例，首次发布',
  ])
  await expect(kb.synthesizeCases('docs', '../escape', 1, by)).rejects.toThrow('ID')
})
it('合成缺模型和模型格式错误给出明确错误，不写入半批用例', async () => {
  const stores2 = await setup()
  await expect(stores2.kb.synthesizeCases('docs', 'generated', 1, by)).rejects.toThrow(
    '需要配置模型',
  )
  const stores3 = await setup({}, { chat: async () => '不是 JSON' })
  await expect(stores3.kb.synthesizeCases('docs', 'generated', 1, by)).rejects.toThrow('合法 JSON')
  expect(await stores3.kb.evalSets('docs')).toEqual([])
})
it('线上采集只收被引用的本库命中，规范化去重、跨集合去重及重复采集幂等', async () => {
  const { kb, stores } = await setup()
  await kb.upsertCases(
    'docs',
    'manual',
    [testCase('existing', 'a', { query: 'already exists' })],
    by,
  )
  const write = async (queryId: string, text: string, refs: string[], via?: 'eval') => {
    const query4 = {
      queryId,
      text,
      at: new Date().toISOString(),
      bases: [{ id: 'docs', version: 1 }],
      top: ['a', 'b'].map((ref) => ({
        baseId: 'docs',
        ref,
        sourceId: 'docs',
        title: ref,
        snippet: ref,
      })),
      latencyMs: 1,
      tokens: 1,
      via,
    }
    await appendQuery(stores, query4)
    await appendQuery(stores, { ...query4, type: 'used', refs })
  }
  await write('1', '  HELLO   World ', ['a'])
  await write('2', 'hello world', ['b'])
  await write('3', 'ALREADY EXISTS', ['a'])
  await write('4', 'uncited', [])
  await write('5', 'evaluation', ['a'], 'eval')
  await write('6', 'forged', ['not-a-hit'])
  const cases = await kb.harvestCases('docs', 'harvested', by)
  expect(cases).toHaveLength(1)
  expect(cases[0]).toMatchObject({
    source: 'harvested',
    status: 'candidate',
    relevant: [
      { ref: 'a', grade: 2 },
      { ref: 'b', grade: 2 },
    ],
  })
  expect(await kb.harvestCases('docs', 'harvested', by)).toEqual([])
})
it('显式 caller 并发隔离，route 返回同一 queryId 且每路由只记一条，旧隐式上下文不参与', async () => {
  const { kb, stores } = await setup()
  await kb.setBindings(
    [{ baseId: 'docs', scope: 'space', enabled: true, priority: 0, roles: ['dev'] }],
    by,
    '绑定',
  )
  const results = await Promise.all(
    ['one', 'two'].map((nodeId) =>
      kb.route(
        { text: '问题' },
        {
          caller: {
            runId: nodeId,
            nodeId,
            requirementId: `req-${nodeId}`,
            role: 'dev',
            via: 'tool',
          },
        },
      ),
    ),
  )
  const records = await readQueries(stores)
  expect(records).toHaveLength(2)
  for (const [index6, nodeId] of ['one', 'two'].entries())
    expect(records.find((query5) => query5.queryId === results[index6]?.queryId)).toMatchObject({
      runId: nodeId,
      nodeId,
      requirementId: `req-${nodeId}`,
      role: 'dev',
      via: 'tool',
    })
  expect(results.every((hit2) => hit2.hits.length === 1)).toBe(true)
  const usage = await knowledgeUsage(stores, 'docs')
  expect(usage.usage7d.queries).toBe(2)
  expect(await knowledgeRisks({ id: 'space', stores })).toEqual([])
})
it('stale 起点持久化，编辑配置不会重置三天计时，发布后清除', async () => {
  const { kb, root, stores } = await setup()
  await kb.update('docs', { description: '过期变更' }, by, '修改')
  const file = join(root, '.takt/knowledge/docs/stale.json')
  const since = '2026-01-01T00:00:00Z'
  await writeFile(file, JSON.stringify({ since, version: 1 }))
  await kb.update('docs', { description: '再次编辑' }, by, '再次修改')
  expect(JSON.parse(await readFile(file, 'utf8')).since).toBe(since)
  expect(
    (await knowledgeRisks({ id: 'space', stores }, new Date('2026-01-05'))).some((record2) =>
      record2.key.endsWith('/stale'),
    ),
  ).toBe(true)
  await kb.publish('docs', { by, reason: '重新发布', version: 1 })
  await expect(readFile(file)).rejects.toMatchObject({ code: 'ENOENT' })
})
it('真实 SQLite 评测贯通 executed：成功、空结果、守卫拦截、执行错误的分母准确', async (ctx) => {
  const module = 'node:sqlite'
  let sqlite: typeof import('node:sqlite')
  try {
    sqlite = await import(module)
  } catch {
    ctx.skip()
    return
  }
  const root = await mkdtemp(join(tmpdir(), 'takt-eval-sql-'))
  roots.push(root)
  await writeFile(
    join(root, 'takt.config.json'),
    JSON.stringify({ project: { name: 'eval-db' }, workflows: [] }),
  )
  const file = join(root, 'data.db')
  const db = new sqlite.DatabaseSync(file)
  db.exec('CREATE TABLE orders (total INTEGER); INSERT INTO orders VALUES (12)')
  db.close()
  const stores = await openProject(root)
  const kb = createKnowledgeStore(stores, {
    secrets: { resolve: async () => file, set: async () => {}, list: async () => [] },
  })
  await kb.create(
    {
      id: 'docs',
      name: '数据库',
      kind: 'database',
      config: { driver: 'sqlite', connection: 'secret:fixture' },
    },
    by,
    '新建',
  )
  const build = await kb.build('docs', by, '构建')
  await vi.waitFor(async () =>
    expect((await kb.getBuild('docs', build.id))?.status).toBe('succeeded'),
  )
  await kb.publish('docs', { by, reason: '发布' })
  await kb.upsertCases(
    'docs',
    'sql',
    [
      testCase('success', 'unused', { query: 'SELECT total FROM orders', answer: '{"total":12}' }),
      testCase('empty', 'unused', {
        query: 'SELECT total FROM orders WHERE total = 0',
        answer: '[]',
      }),
      testCase('blocked', 'unused', {
        query: 'SELECT total FROM orders; DELETE FROM orders',
        answer: '{"total":12}',
      }),
      testCase('failure', 'unused', { query: 'SELECT missing_column FROM orders' }),
    ],
    by,
  )
  const run = await kb.runEval('docs', {
    setId: 'sql',
    variants: [{ id: 'sql', label: 'SQL' }],
    by,
  })
  const result = await done(kb, run.id)
  expect(result.status).toBe('done')
  expect(result.metrics.sql).toMatchObject({
    n: 4,
    sqlSuccess: 0.5,
    resultAccuracy: 2 / 3,
    blocked: 1,
  })
  expect(result.error).toContain('调用失败')
})
