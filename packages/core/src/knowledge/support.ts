import { AsyncLocalStorage } from 'node:async_hooks'
import { copyFile, mkdir, mkdtemp, readFile, rm, open } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { setTimeout } from 'node:timers/promises'
import type { Actor, TaktConfig, KnowledgeHit } from '../types.js'
import type { ProjectStores } from '../interfaces.js'
import { FsEventStore } from '../store/fs-events.js'
import { withLock } from '../store/locks.js'
import { writeFileAtomic, readJsonFile, appendLine, readJsonLines, assertNoSymlinks } from '../store/fs-utils.js'
export { validateSchema } from '../engine/schema.js'
export { assertNoSymlinks, writeFileAtomic, readJsonFile, readJsonLines, appendLine } from '../store/fs-utils.js'

export interface KnowledgeQueryIdentity { queryId?: string; runId?: string; nodeId?: string; requirementId?: string; workflowId?: string; role?: string; via?: 'prefetch' | 'tool' }
export interface KnowledgeQueryRecord extends KnowledgeQueryIdentity { queryId: string; at: string; text: string; intent?: string; bases: Array<{ id: string; version: number }>; top: KnowledgeHit[]; latencyMs: number; tokens: number; type?: 'query' | 'used'; refs?: string[] }
const contextKey = Symbol.for('taktflow.knowledge.query-context')
const contexts = globalThis as unknown as Record<symbol, AsyncLocalStorage<KnowledgeQueryIdentity>>
export const knowledgeQueryContext = contexts[contextKey] ??= new AsyncLocalStorage<KnowledgeQueryIdentity>()
export const readKnowledgeQueries = (stores: ProjectStores) => readJsonLines<KnowledgeQueryRecord>(join(stores.taktDir, 'knowledge/queries.jsonl'))
export const appendKnowledgeQuery = async (stores: ProjectStores, record: KnowledgeQueryRecord) => { const file = join(stores.taktDir, 'knowledge/queries.jsonl'); await assertNoSymlinks(stores.taktDir, file); await appendLine(file, JSON.stringify(record)) }

// 与 server 的 spaceLock 使用相同锁文件，使 CLI 和 HTTP 配置写入互斥。
export function knowledgeFileLock<T>(file: string, fn: () => Promise<T>): Promise<T> {
  return withLock(file, async () => {
    await mkdir(dirname(file), { recursive: true })
    const lock = `${file}.lock`, deadline = Date.now() + 10000
    let handle
    for (;;) {
      try { handle = await open(lock, 'wx'); break } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        if (Date.now() > deadline) throw new Error('知识库写入锁超时，请稍后重试')
        await setTimeout(10)
      }
    }
    try { return await fn() } finally { await handle.close(); await rm(lock, { force: true }) }
  })
}
export async function auditKnowledge(stores: ProjectStores, actor: Actor, reason: string, message: string): Promise<void> {
  if (!reason?.trim()) throw new Error('写操作必须提供 reason，请填写修改原因')
  await knowledgeFileLock(join(stores.taktDir, 'space-events.jsonl'), async () => {
    const scratch = await mkdtemp(join(tmpdir(), 'takt-kb-audit-'))
    const file = join(stores.taktDir, 'space-events.jsonl'), target = join(scratch, 'runs/space/events.jsonl')
    try {
      await mkdir(dirname(target), { recursive: true })
      try { await copyFile(file, target) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
      const events = new FsEventStore(scratch)
      if (!(await events.verify('space')).ok) throw new Error('空间审计链损坏，请先修复审计日志')
      await events.append('space', { type: 'log', actor, data: { level: 'info', message: JSON.stringify({ message, reason }) } })
      await writeFileAtomic(file, await readFile(target))
    } finally { await rm(scratch, { recursive: true, force: true }) }
  })
}
export async function changeKnowledgeConfig(stores: ProjectStores, actor: Actor, reason: string, message: string, change: (config: TaktConfig) => void): Promise<void> {
  const file = join(stores.projectDir, 'takt.config.json')
  await knowledgeFileLock(file, async () => {
    const config = await readJsonFile<TaktConfig>(file) ?? structuredClone(stores.config)
    change(config)
    await auditKnowledge(stores, actor, reason, message)
    await writeFileAtomic(file, JSON.stringify(config, null, 2) + '\n')
    stores.config = config
  })
}
