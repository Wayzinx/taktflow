import { sqliteQuery } from './sqlite-query.js'
import { type KnowledgeKind, type KnowledgeBase, type KnowledgeKindContext, type KnowledgeHit } from '@taktflow/core'
import { bm25, loadIndex, makeIndex, saveIndex, trimHits } from './search.js'
import { sha256 } from '@taktflow/core'
export class KnowledgeBlockedError extends Error { constructor(readonly kind: 'sql' | 'http', readonly text: string, reason: string) { super(reason) } }
export function guardSql(input: string, limit = 200): string {
  if (!Number.isInteger(limit) || limit < 1 || limit > 10000) throw new Error('rowLimit 必须在 1 到 10000 之间，请修改配置')
  const sql = input.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\r\n]*/g, ' ').trim().replace(/;\s*$/, '').trim()
  const blocked = (why: string): never => { throw new KnowledgeBlockedError('sql', input, `${why}，请使用单条只读查询`) }
  if (sql.includes(';')) blocked('不允许多条 SQL')
  if (!/^(select|with|show|describe|explain)\b/i.test(sql)) blocked('只允许 SELECT、WITH、SHOW、DESCRIBE 或 EXPLAIN')
  if (/\b(insert|update|delete|drop|alter|create|truncate|grant|revoke|merge|call|copy|attach|pragma|into)\b|\bfor\s+update\b/i.test(sql)) blocked('SQL 包含写操作关键字')
  // EXPLAIN ANALYZE 和数据库函数也可能产生副作用，保守拒绝执行计划的执行选项与危险内置函数。
  if (/\b(analyze|load_extension|pg_sleep|pg_read_file|pg_write_file|dblink|lo_import|lo_export|set_config|sleep|benchmark|readfile|writefile)\b/i.test(sql)) blocked('SQL 包含可能产生副作用的操作')
  return /^(select|with)\b/i.test(sql) && !/\blimit\s+\d+\b/i.test(sql) ? `${sql} LIMIT ${limit}` : sql
}
export function maskRow(row: Record<string, unknown>, mask: Record<string, string | boolean> = {}): Record<string, unknown> {
  return Object.fromEntries(Object.entries(row).map(([key, value]) => {
    if (mask[key] === true || mask[key] === 'redact') return [key, '***']
    if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'bigint') return [key, value]
    const str = String(value)
    const masked = str.replace(/\b1[3-9]\d{9}\b/g, s => `${s.slice(0, 3)}****${s.slice(-4)}`).replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, s => `${s[0]}***@${s.split('@')[1]}`).replace(/\b\d{17}[\dXx]\b/g, s => `${s.slice(0, 3)}***********${s.slice(-4)}`)
    return [key, masked === str && typeof value !== 'bigint' ? value : masked]
  }))
}
interface Connection { query(sql: string): Promise<Record<string, unknown>[]>; close(): Promise<void> }
async function connect(kb: KnowledgeBase, ctx: KnowledgeKindContext): Promise<Connection> {
  const driver = String(kb.config.driver ?? 'sqlite'), limit = Number(kb.config.rowLimit ?? 200), timeout = Number(kb.config.timeoutMs ?? 5000)
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 30000) throw new Error('超时必须在 1 到 30000 毫秒之间，请修改配置')
  if (driver !== 'sqlite' && ctx.stores.config.sandbox?.network === 'none') throw new Error('空间禁止网络连接，请调整网络策略后连接数据库')
  const ref = String(kb.config.connection ?? ''), url = await ctx.secrets.resolve(ref)
  if (!url) throw new Error('数据库密钥不存在，请先保存连接密钥')
  if (driver === 'sqlite') {
    return { query: sql => sqliteQuery(url, guardSql(sql, limit), limit, timeout, ctx.signal), async close() {} }
  }
  if (driver === 'postgres') {
    const module = 'pg'
    let pkg: { Client: new (opts: Record<string, unknown>) => { connect(): Promise<void>; query(sql: string): Promise<{ rows: Record<string, unknown>[] }>; end(): Promise<void> } }
    try { pkg = await import(module) as typeof pkg } catch { throw new Error('需要安装 pg：npm i pg；请安装后重试') }
    const db = new pkg.Client({ connectionString: url, statement_timeout: timeout, query_timeout: timeout, connectionTimeoutMillis: timeout }); try { await db.connect() } catch { await db.end().catch(() => undefined); throw new Error('Postgres 连接失败，请检查连接密钥和网络') }
    return { async query(sql) { await db.query('BEGIN READ ONLY'); try { return (await db.query(guardSql(sql, limit))).rows.slice(0, limit) } finally { await db.query('ROLLBACK') } }, close: () => db.end() }
  }
  if (driver === 'mysql') {
    const module = 'mysql2/promise'
    let pkg: { createConnection(opts: unknown): Promise<{ query(sql: string | { sql: string; timeout: number }): Promise<[Record<string, unknown>[], unknown]>; end(): Promise<void> }> }
    try { pkg = await import(module) as typeof pkg } catch { throw new Error('需要安装 mysql2：npm i mysql2；请安装后重试') }
    let db: Awaited<ReturnType<typeof pkg.createConnection>>
    try { const parsed = new URL(url); db = await pkg.createConnection({ host: parsed.hostname, port: Number(parsed.port || 3306), user: decodeURIComponent(parsed.username), password: decodeURIComponent(parsed.password), database: parsed.pathname.slice(1), connectTimeout: timeout }) } catch { throw new Error('MySQL 连接失败，请检查连接密钥和网络') }
    return { async query(sql) { await db.query('START TRANSACTION READ ONLY'); try { return (await db.query({ sql: guardSql(sql, limit), timeout }))[0].slice(0, limit) } finally { await db.query('ROLLBACK') } }, close: () => db.end() }
  }
  throw new Error('数据库驱动不支持，请选择 sqlite、postgres 或 mysql')
}
export const databaseKind: KnowledgeKind = {
  kind: 'database', title: '数据库', summary: '表结构、字段口径和只读实时数据', intents: ['schema', 'fact'], needsBuild: true,
  configSchema: { type: 'object', required: ['driver', 'connection'], properties: { driver: { type: 'string', enum: ['sqlite', 'postgres', 'mysql'] }, connection: { type: 'string', format: 'secret' }, tables: { type: 'array', items: { type: 'string' } }, schemas: { type: 'array', items: { type: 'string' } }, rowLimit: { type: 'integer' }, notes: { type: 'object' }, mask: { type: 'object' } } },
  async available() {
    for (const module of ['node:sqlite', 'pg', 'mysql2/promise']) try { await import(module); return { ok: true } } catch { /* 继续检测另一个可选驱动。 */ }
    return { ok: false, reason: '需要支持 node:sqlite 的 Node，或安装 pg：npm i pg / mysql2：npm i mysql2' }
  },
  async test(kb, ctx) { const db = await connect(kb, ctx); try { await db.query('SELECT 1'); return { ok: true, message: '只读连接成功' } } finally { await db.close() } },
  async build(kb, ctx, progress) {
    const db = await connect(kb, ctx)
    try {
      const sqlite = kb.config.driver === 'sqlite'
      const rows = await db.query(sqlite ? "SELECT name AS table_name, sql AS definition FROM sqlite_master WHERE type = 'table'" : kb.config.driver === 'mysql' ? 'SELECT table_schema, table_name, column_name, data_type, column_comment FROM information_schema.columns' : 'SELECT c.table_schema, c.table_name, c.column_name, c.data_type, pg_catalog.col_description(t.oid, c.ordinal_position) AS comment FROM information_schema.columns c JOIN pg_catalog.pg_namespace n ON n.nspname = c.table_schema JOIN pg_catalog.pg_class t ON t.relnamespace = n.oid AND t.relname = c.table_name')
      const allowed = kb.config.tables as string[] | undefined, schemas = kb.config.schemas as string[] | undefined
      let selected = rows.filter(r => (!allowed || allowed.includes(String(r.table_name))) && (!schemas || !r.table_schema || schemas.includes(String(r.table_schema))))
      if (sqlite) {
        const columns: Record<string, unknown>[] = []
        for (const table of selected) {
          const name = String(table.table_name)
          if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) continue
          for (const column of await db.query(`SELECT name AS column_name, type AS data_type FROM pragma_table_info('${name}')`)) columns.push({ table_name: name, ...column })
        }
        selected = columns
      }
      const notes = kb.config.notes as Record<string, unknown> ?? {}
      const chunks = selected.map((r, i) => { const text = JSON.stringify({ ...r, notes: notes[String(r.table_name)] ?? notes[`${r.table_name}.${r.column_name}`] }); return { ref: `${r.table_name}${r.column_name ? `.${r.column_name}` : ''}`, title: String(r.table_name), content: text, hash: sha256(text) } })
      await saveIndex(ctx.indexDir, makeIndex(chunks)); progress({ stage: 'snapshot', done: chunks.length, total: chunks.length })
      return { stats: { docs: chunks.length, chunks: chunks.length, bytes: JSON.stringify(selected).length, tables: new Set(selected.map(r => r.table_name)).size } }
    } finally { await db.close() }
  },
  async query(kb, q, ctx, retrieval) {
    if (/^\s*(select|with|show|describe|explain)\b/i.test(q.text)) {
      const sql = guardSql(q.text, Number(kb.config.rowLimit ?? 200)), db = await connect(kb, ctx)
      try { return (await db.query(sql)).map((row, i): KnowledgeHit => ({ sourceId: kb.id, ref: `sql:${sha256(sql).slice(0, 16)}#${i}`, title: `结果 ${i + 1}`, snippet: JSON.stringify(maskRow(row, kb.config.mask as Record<string, string | boolean>)), score: 1, evidenceLevel: 'verified', fetchedAt: new Date().toISOString() })) } finally { await db.close() }
    }
    const index = await loadIndex(ctx.indexDir)
    return trimHits(bm25(index, q.text).map(r => ({ sourceId: kb.id, ref: index.chunks[r.i]!.ref, title: index.chunks[r.i]!.title, snippet: index.chunks[r.i]!.content, score: r.score / (1 + r.score), evidenceLevel: 'derived' as const })), retrieval)
  },
}
