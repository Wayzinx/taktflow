import { afterEach, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openProject, type KnowledgeBase, type KnowledgeKindContext } from '@taktflow/core'
import { databaseKind, guardSql, maskRow } from './database.js'
const hits = (result: Awaited<ReturnType<typeof databaseKind.query>>) =>
  Array.isArray(result) ? result : result.hits
const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
it.each([
  'INSERT',
  'UPDATE',
  'DELETE',
  'DROP',
  'ALTER',
  'CREATE',
  'TRUNCATE',
  'GRANT',
  'REVOKE',
  'MERGE',
  'CALL',
  'COPY',
  'ATTACH',
  'PRAGMA',
  'INTO',
  'FOR UPDATE',
])('只读守卫拒绝 %s', (word) => {
  expect(() => guardSql(`WITH x AS (SELECT 1) SELECT ${word}`)).toThrow('只读')
})
it.each([
  'SELECT 1; SELECT 2',
  'DELETE FROM t',
  'WITH x AS (DELETE FROM t RETURNING *) SELECT * FROM x',
  'EXPLAIN ANALYZE SELECT 1',
  'SELECT load_extension(1)',
  'SELECT pg_sleep(1)',
])('阻止 SQL 绕过：%s', (sql) => {
  expect(() => guardSql(sql)).toThrow()
})
it('去注释、限制结果、不重复补 LIMIT', () => {
  expect(guardSql('-- hi\n SELECT 1 /* hi */;')).toBe(
    'SELECT * FROM (SELECT 1) AS takt_result LIMIT 200',
  )
  expect(guardSql('SELECT 1 LIMIT 10')).toBe(
    'SELECT * FROM (SELECT 1 LIMIT 10) AS takt_result LIMIT 200',
  )
  expect(guardSql('WITH a AS (SELECT 1) SELECT * FROM a', 5)).toContain('LIMIT 5')
})
it('手机号邮箱身份证默认脱敏，列规则可以强制打码', () => {
  expect(
    maskRow(
      {
        phone: '13812345678',
        email: 'test@example.com',
        id: '110101199001011234',
        custom: 'secret',
      },
      { custom: true },
    ),
  ).toEqual({
    phone: '138****5678',
    email: 't***@example.com',
    id: '110***********1234',
    custom: '***',
  })
})
it('SQLite 只读执行、结构索引和实时数据', async (ctx) => {
  const module = 'node:sqlite'
  let sqlite: typeof import('node:sqlite')
  try {
    sqlite = await import(module)
  } catch {
    ctx.skip()
    return
  }
  const root = await mkdtemp(join(tmpdir(), 'takt-db-'))
  roots.push(root)
  await writeFile(
    join(root, 'takt.config.json'),
    JSON.stringify({ project: { name: 'test' }, workflows: [] }),
  )
  const path = join(root, 'data.sqlite')
  const db = new sqlite.DatabaseSync(path)
  db.exec(
    "CREATE TABLE customers (id INTEGER, phone TEXT); INSERT INTO customers VALUES (1, '13812345678')",
  )
  db.close()
  const stores = await openProject(root)
  const context: KnowledgeKindContext = {
    stores,
    baseDir: root,
    indexDir: join(root, 'v1'),
    secrets: { resolve: async () => path, set: async () => {}, list: async () => [] },
  }
  const base: KnowledgeBase = {
    id: 'db',
    name: 'db',
    kind: 'database',
    config: { driver: 'sqlite', connection: 'secret:db' },
    description: '',
    intents: ['schema'],
    scope: 'space',
    version: 0,
    status: 'draft',
    retrieval: { topK: 8, budgetTokens: 4000 },
    createdAt: '',
    updatedAt: '',
    createdBy: { type: 'human', id: 'test' },
  }
  expect(
    await databaseKind.query(
      base,
      { text: 'SELECT * FROM customers; DELETE FROM customers' },
      context,
      base.retrieval,
    ),
  ).toMatchObject({ hits: [], executed: { kind: 'sql', blocked: expect.stringContaining('多条') } })
  expect(
    await databaseKind.query(base, { text: 'SELECT * FROM customers' }, context, base.retrieval),
  ).toMatchObject({
    executed: {
      kind: 'sql',
      text: 'SELECT * FROM (SELECT * FROM customers) AS takt_result LIMIT 200',
    },
  })
  expect((await databaseKind.build!(base, context, () => {})).stats.tables).toBe(1)
  expect(
    hits(await databaseKind.query(base, { text: 'customers' }, context, base.retrieval))
      .map((hit) => hit.snippet)
      .join('\n'),
  ).toContain('phone')
  expect(
    hits(
      await databaseKind.query(base, { text: 'SELECT * FROM customers' }, context, base.retrieval),
    )[0],
  ).toMatchObject({ evidenceLevel: 'verified', snippet: expect.stringContaining('138****5678') })
})
it('M4-2：SQL 执行遵守表与 schema 白名单，别名不能绕过脱敏', async () => {
  const sqlite = await import('node:sqlite')
  const root = await mkdtemp(join(tmpdir(), 'takt-db-policy-'))
  roots.push(root)
  await writeFile(
    join(root, 'takt.config.json'),
    JSON.stringify({ project: { name: 'test' }, workflows: [] }),
  )
  const path = join(root, 'data.sqlite')
  const db = new sqlite.DatabaseSync(path)
  db.exec(
    "CREATE TABLE users (phone TEXT); INSERT INTO users VALUES ('x'); CREATE TABLE private (secret TEXT)",
  )
  db.close()
  const stores = await openProject(root)
  const context: KnowledgeKindContext = {
    stores,
    baseDir: root,
    indexDir: root,
    secrets: { resolve: async () => path, set: async () => {}, list: async () => [] },
  }
  const base: KnowledgeBase = {
    id: 'db',
    name: 'db',
    kind: 'database',
    config: { driver: 'sqlite', connection: 'secret:db', tables: ['users'], mask: { phone: true } },
    description: '',
    intents: ['schema'],
    scope: 'space',
    version: 0,
    status: 'draft',
    retrieval: { topK: 8, budgetTokens: 4000 },
    createdAt: '',
    updatedAt: '',
    createdBy: { type: 'human', id: 'test' },
  }
  for (const text of [
    'SELECT * FROM private',
    'SELECT * FROM users, private',
    'SELECT * FROM main.private',
  ]) {
    expect(await databaseKind.query(base, { text }, context, base.retrieval)).toMatchObject({
      hits: [],
      executed: { blocked: expect.any(String) },
    })
  }
  expect(
    hits(
      await databaseKind.query(
        base,
        { text: 'SELECT phone AS p FROM users' },
        context,
        base.retrieval,
      ),
    )[0]?.content,
  ).toBe('{"p":"***"}')
})
