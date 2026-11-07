import { sqlTokens, identifier, checkTables } from './sql-policy.js'
import { sqliteQuery } from './sqlite-query.js'
import { readFile } from 'node:fs/promises'
import { relative } from 'node:path'
import {
  type KnowledgeKind,
  type KnowledgeBase,
  type KnowledgeKindContext,
  type KnowledgeHit,
} from '@taktflow/core'
import { bm25, loadIndex, makeIndex, saveIndex, trimHits } from './search.js'
import { sha256 } from '@taktflow/core'
export class KnowledgeBlockedError extends Error {
  constructor(
    readonly kind: 'sql' | 'http',
    readonly text: string,
    reason: string,
  ) {
    super(reason)
  }
}
export function guardSql(input: string, limit = 200): string {
  if (!Number.isInteger(limit) || limit < 1 || limit > 10000)
    throw new Error('rowLimit 必须在 1 到 10000 之间，请修改配置')
  const blocked = (why: string): never => {
    throw new KnowledgeBlockedError('sql', input, `${why}，请使用单条只读查询`)
  }
  let tokens: string[]
  try {
    tokens = sqlTokens(input)
  } catch (error) {
    return blocked((error as Error).message)
  }
  if (tokens.at(-1) === ';') tokens.pop()
  const sql = tokens.join(' ')
  const keywords = tokens
    .filter((token) => !token.startsWith("'"))
    .map(identifier)
    .join(' ')
  if (tokens.includes(';')) blocked('不允许多条 SQL')
  if (!/^(select|with|show|describe|explain)\b/i.test(keywords))
    blocked('只允许 SELECT、WITH、SHOW、DESCRIBE 或 EXPLAIN')
  if (
    /\b(insert|update|delete|drop|alter|create|truncate|grant|revoke|merge|call|copy|attach|pragma|into)\b/i.test(
      keywords,
    )
  )
    blocked('SQL 包含写操作关键字')
  const unsafeFunction = [
    'analyze',
    'load_extension',
    'pg_(?:terminate|cancel|read|ls|stat_file|reload|advisory)\\w*',
    'lo_\\w*',
    'load_file',
    'get_lock',
    'release_lock',
    'dblink\\w*',
    'set_config',
    'pg_sleep',
    'sleep',
    'benchmark',
    'readfile',
    'writefile',
  ].join('|')
  if (new RegExp(`\\b(?:${unsafeFunction})\\b`, 'i').test(keywords))
    blocked('SQL 包含可能产生副作用的操作')
  return /^(select|with)\b/i.test(sql)
    ? `SELECT * FROM (${sql}) AS takt_result LIMIT ${limit}`
    : sql
}
export function maskRow(
  row: Record<string, unknown>,
  mask: Record<string, string | boolean> = {},
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => {
      if (mask[key] === true || mask[key] === 'redact') return [key, '***']
      if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'bigint')
        return [key, value]
      const str = String(value)
      const masked = str
        .replace(/\b1[3-9]\d{9}\b/g, (total2) => `${total2.slice(0, 3)}****${total2.slice(-4)}`)
        .replace(
          /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi,
          (total3) => `${total3[0]}***@${total3.split('@')[1]}`,
        )
        .replace(
          /\b\d{17}[\dXx]\b/g,
          (total4) => `${total4.slice(0, 3)}***********${total4.slice(-4)}`,
        )
      return [key, masked === str && typeof value !== 'bigint' ? value : masked]
    }),
  )
}
interface Connection {
  query(sql: string): Promise<Record<string, unknown>[]>
  close(): Promise<void>
  sourcePath?: string
}
async function connect(kb: KnowledgeBase, ctx: KnowledgeKindContext): Promise<Connection> {
  const driver = String(kb.config.driver ?? 'sqlite')
  const limit = Number(kb.config.rowLimit ?? 200)
  const timeout = Number(kb.config.timeoutMs ?? 5000)
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 30000)
    throw new Error('超时必须在 1 到 30000 毫秒之间，请修改配置')
  if (driver !== 'sqlite' && ctx.stores.config.sandbox?.network === 'none')
    throw new Error('空间禁止网络连接，请调整网络策略后连接数据库')
  const ref = String(kb.config.connection ?? '')
  const url = await ctx.secrets.resolve(ref)
  if (!url) throw new Error('数据库密钥不存在，请先保存连接密钥')
  if (driver === 'sqlite') {
    return {
      query: (sql) => sqliteQuery(url, guardSql(sql, limit), limit, timeout, ctx.signal),
      async close() {},
      sourcePath: url,
    }
  }
  if (driver === 'postgres') {
    const module = 'pg'
    let pkg: {
      Client: new (opts: Record<string, unknown>) => {
        connect(): Promise<void>
        query(sql: string): Promise<{ rows: Record<string, unknown>[] }>
        end(): Promise<void>
      }
    }
    try {
      pkg = (await import(module)) as typeof pkg
    } catch {
      throw new Error('需要安装 pg：npm i pg；请安装后重试')
    }
    const db = new pkg.Client({
      connectionString: url,
      statement_timeout: timeout,
      query_timeout: timeout,
      connectionTimeoutMillis: timeout,
    })
    try {
      await db.connect()
    } catch {
      await db.end().catch(() => undefined)
      throw new Error('Postgres 连接失败，请检查连接密钥和网络')
    }
    return {
      async query(sql) {
        await db.query('BEGIN READ ONLY')
        try {
          return (await db.query(guardSql(sql, limit))).rows.slice(0, limit)
        } finally {
          await db.query('ROLLBACK')
        }
      },
      close: () => db.end(),
    }
  }
  if (driver === 'mysql') {
    const module = 'mysql2/promise'
    let pkg: {
      createConnection(opts: unknown): Promise<{
        query(
          sql: string | { sql: string; timeout: number },
        ): Promise<[Record<string, unknown>[], unknown]>
        end(): Promise<void>
      }>
    }
    try {
      pkg = (await import(module)) as typeof pkg
    } catch {
      throw new Error('需要安装 mysql2：npm i mysql2；请安装后重试')
    }
    let db: Awaited<ReturnType<typeof pkg.createConnection>>
    try {
      const parsed = new URL(url)
      db = await pkg.createConnection({
        host: parsed.hostname,
        port: Number(parsed.port || 3306),
        user: decodeURIComponent(parsed.username),
        password: decodeURIComponent(parsed.password),
        database: parsed.pathname.slice(1),
        connectTimeout: timeout,
      })
    } catch {
      throw new Error('MySQL 连接失败，请检查连接密钥和网络')
    }
    return {
      async query(sql) {
        await db.query('START TRANSACTION READ ONLY')
        try {
          return (await db.query({ sql: guardSql(sql, limit), timeout }))[0].slice(0, limit)
        } finally {
          await db.query('ROLLBACK')
        }
      },
      close: () => db.end(),
    }
  }
  throw new Error('数据库驱动不支持，请选择 sqlite、postgres 或 mysql')
}

function schemaSql(driver: unknown): string {
  if (driver === 'sqlite') {
    return "SELECT name AS table_name, sql AS definition FROM sqlite_master WHERE type = 'table'"
  }
  if (driver === 'mysql') {
    return 'SELECT table_schema, table_name, column_name, data_type, column_comment FROM information_schema.columns'
  }
  return [
    'SELECT c.table_schema, c.table_name, c.column_name, c.data_type,',
    'pg_catalog.col_description(t.oid, c.ordinal_position) AS comment',
    'FROM information_schema.columns c',
    'JOIN pg_catalog.pg_namespace n ON n.nspname = c.table_schema',
    'JOIN pg_catalog.pg_class t ON t.relnamespace = n.oid AND t.relname = c.table_name',
  ].join(' ')
}

export const databaseKind: KnowledgeKind = {
  kind: 'database',
  title: '数据库',
  summary: '表结构、字段口径和只读实时数据',
  intents: ['schema', 'fact'],
  needsBuild: true,
  configSchema: {
    type: 'object',
    required: ['driver', 'connection'],
    properties: {
      driver: { type: 'string', enum: ['sqlite', 'postgres', 'mysql'] },
      connection: { type: 'string', format: 'secret' },
      tables: { type: 'array', items: { type: 'string' } },
      schemas: { type: 'array', items: { type: 'string' } },
      rowLimit: { type: 'integer' },
      notes: { type: 'object' },
      mask: { type: 'object' },
    },
  },
  async available() {
    for (const module of ['node:sqlite', 'pg', 'mysql2/promise'])
      try {
        await import(module)
        return { ok: true }
      } catch {
        /* 继续检测另一个可选驱动。 */
      }
    return {
      ok: false,
      reason: '需要支持 node:sqlite 的 Node，或安装 pg：npm i pg / mysql2：npm i mysql2',
    }
  },
  async test(kb, ctx) {
    const db = await connect(kb, ctx)
    try {
      await db.query('SELECT 1')
      return { ok: true, message: '只读连接成功' }
    } finally {
      await db.close()
    }
  },
  async build(kb, ctx, progress) {
    const db = await connect(kb, ctx)
    try {
      const sqlite = kb.config.driver === 'sqlite'
      const rows = await db.query(schemaSql(kb.config.driver))
      const allowed = kb.config.tables as string[] | undefined
      const schemas = kb.config.schemas as string[] | undefined
      let selected = rows.filter(
        (record) =>
          (!allowed || allowed.includes(String(record.table_name))) &&
          (!schemas || !record.table_schema || schemas.includes(String(record.table_schema))),
      )
      if (sqlite) {
        const columns: Record<string, unknown>[] = []
        for (const table of selected) {
          const name = String(table.table_name)
          if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) continue
          for (const column of await db.query(
            `SELECT name AS column_name, type AS data_type FROM pragma_table_info('${name}')`,
          ))
            columns.push({ table_name: name, ...column })
        }
        selected = columns
      }
      const notes = (kb.config.notes as Record<string, unknown>) ?? {}
      const chunks = selected.map((record2, index2) => {
        const text = JSON.stringify({
          ...record2,
          notes:
            notes[String(record2.table_name)] ??
            notes[`${record2.table_name}.${record2.column_name}`],
        })
        return {
          ref: `${record2.table_name}${record2.column_name ? `.${record2.column_name}` : ''}`,
          title: String(record2.table_name),
          content: text,
          hash: sha256(text),
        }
      })
      const index = makeIndex(chunks)
      if (sqlite && db.sourcePath && !db.sourcePath.includes('://') && db.sourcePath !== ':memory:') {
        const path = relative(ctx.stores.projectDir, db.sourcePath)
        if (!path.startsWith('..')) index.manifest = [{ path, hash: sha256(await readFile(db.sourcePath)) }]
      }
      await saveIndex(ctx.indexDir, index)
      progress({ stage: 'snapshot', done: chunks.length, total: chunks.length })
      return {
        stats: {
          docs: chunks.length,
          chunks: chunks.length,
          bytes: JSON.stringify(selected).length,
          tables: new Set(selected.map((record3) => record3.table_name)).size,
        },
      }
    } finally {
      await db.close()
    }
  },
  async query(kb, query2, ctx, retrieval) {
    try {
      if (/^\s*(select|with|show|describe|explain)\b/i.test(query2.text)) {
        let sql: string
        try {
          checkTables(sqlTokens(query2.text), kb.config)
          sql = guardSql(query2.text, Number(kb.config.rowLimit ?? 200))
        } catch (error) {
          throw new KnowledgeBlockedError('sql', query2.text, (error as Error).message)
        }
        const db = await connect(kb, ctx)
        try {
          const hits = (await db.query(sql)).map((row, index3): KnowledgeHit => {
            const content = JSON.stringify(
              maskQueryRow(row, kb.config.mask as Record<string, string | boolean>),
            )
            return {
              sourceId: kb.id,
              ref: `sql:${sha256(sql).slice(0, 16)}#${index3}`,
              title: `结果 ${index3 + 1}`,
              snippet: content,
              content,
              score: 1,
              evidenceLevel: 'verified',
              fetchedAt: new Date().toISOString(),
            }
          })
          return { executed: { kind: 'sql', text: sql }, hits }
        } finally {
          await db.close()
        }
      }
      const index = await loadIndex(ctx.indexDir)
      return trimHits(
        bm25(index, query2.text).map((record4) => ({
          sourceId: kb.id,
          ref: index.chunks[record4.i]!.ref,
          title: index.chunks[record4.i]!.title,
          snippet: index.chunks[record4.i]!.content,
          content: index.chunks[record4.i]!.content,
          score: record4.score / (1 + record4.score),
          evidenceLevel: 'derived' as const,
        })),
        retrieval,
      )
    } catch (error) {
      if (error instanceof KnowledgeBlockedError)
        return {
          hits: [],
          executed: { kind: error.kind, text: error.text, blocked: error.message },
        }
      throw error
    }
  },
}

function maskQueryRow(
  row: Record<string, unknown>,
  mask: Record<string, string | boolean> = {},
): Record<string, unknown> {
  // 驱动未统一提供来源列元数据；有自定义脱敏规则时全列遮蔽，表达式和别名不能绕过。
  if (Object.values(mask).some((value) => value === true || value === 'redact')) {
    return Object.fromEntries(Object.keys(row).map((key) => [key, '***']))
  }
  return maskRow(row)
}
