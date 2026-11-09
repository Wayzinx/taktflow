import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { initProject } from '../store/project.js'
import { AutomationRecords } from './records.js'
import type { AutomationRunRecord } from '../api.js'
const dirs: string[] = []
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }) })
it('开始与终态追加、按执行 ID 合并、每个自动化保留 200，重启恢复中断', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'takt-automation-records-')); dirs.push(dir)
  const store = new AutomationRecords(await initProject(dir))
  const row = (i: number, automationId = 'daily'): AutomationRunRecord => ({ id: String(i), automationId, at: new Date(1700000000000 + i * 1000).toISOString(), status: 'running', summary: '开始', trigger: 'manual', deliveries: [] })
  await store.write(row(0, 'other'))
  for (let i = 1; i <= 202; i++) { await store.write(row(i)); await store.write({ ...row(i), status: 'ok' }) }
  expect(await store.list('daily')).toHaveLength(200)
  expect((await store.list('daily', 20))[0]!.id).toBe('202')
  expect((await store.list('daily')).at(-1)!.id).toBe('3')
  const raw = await readFile(store.file, 'utf8')
  expect(raw.split('\n').filter(Boolean).length).toBe(401)
  await store.recover()
  expect((await store.list('other'))[0]).toMatchObject({ status: 'failed', error: 'serve 重启，执行中断' })
  expect(await store.list('daily')).toHaveLength(200)
})
