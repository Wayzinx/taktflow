import { Worker } from 'node:worker_threads'
// DatabaseSync 在隔离线程执行；超时/取消会终止线程，避免同步 SQL 阻塞服务事件循环。
export function sqliteQuery(
  path: string,
  sql: string,
  rowLimit: number,
  timeout: number,
  signal?: AbortSignal,
): Promise<Record<string, unknown>[]> {
  signal?.throwIfAborted()
  return new Promise((resolve, reject) => {
    const worker = new Worker(
      `
      const { parentPort, workerData } = require('node:worker_threads');
      const { DatabaseSync } = require('node:sqlite');
      let db;
      try {
        db = new DatabaseSync(workerData.path, { readOnly: true, allowExtension: false });
        db.exec('BEGIN');
        const rows = [];
        for (const row of db.prepare(workerData.sql).iterate()) { rows.push(row); if (rows.length >= workerData.rowLimit) break; }
        parentPort.postMessage({ rows });
      } catch (error) { parentPort.postMessage({ error: 'SQLite 只读查询失败，请检查 SQL 和数据库文件' }); }
      finally { if (db) db.close(); }
    `,
      { eval: true, workerData: { path, sql, rowLimit } },
    )
    let settled = false
    const finish = (error?: Error, rows?: Record<string, unknown>[]) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      void worker.terminate()
      if (error) reject(error)
      else resolve(rows ?? [])
    }
    const abort = () => finish(new Error('数据库查询已取消，请按需重试'))
    const timer = setTimeout(() => finish(new Error('数据库查询超时，请缩小查询范围')), timeout)
    signal?.addEventListener('abort', abort, { once: true })
    worker.once('message', (message: { rows?: Record<string, unknown>[]; error?: string }) =>
      finish(message.error ? new Error(message.error) : undefined, message.rows),
    )
    worker.once('error', () =>
      finish(new Error('SQLite 驱动不可用，请使用支持 node:sqlite 的 Node')),
    )
    worker.once('exit', (code) => {
      if (!settled) finish(new Error(`数据库线程退出（${code}），请重新查询`))
    })
  })
}
