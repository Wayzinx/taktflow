import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'

export async function createShopFixture(root: string): Promise<string> {
  await mkdir(join(root, 'fixtures'), { recursive: true })
  const module = 'node:sqlite'
  const { DatabaseSync } = await import(module) as { DatabaseSync: new (path: string) => { exec(sql: string): void; close(): void } }
  const path = join(root, 'fixtures/shop.db')
  const db = new DatabaseSync(path)
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS orders (id INTEGER PRIMARY KEY, month TEXT NOT NULL, amount INTEGER NOT NULL);
      INSERT OR REPLACE INTO orders VALUES (1, '2026-01', 120), (2, '2026-02', 240), (3, '2026-02', 80);`)
  } finally { db.close() }
  return path
}
