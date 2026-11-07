import { copyFile, mkdir, mkdtemp, readFile, rm, open } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { setTimeout } from 'node:timers/promises'
import type { Actor, TaktConfig, KnowledgeHit } from '../types.js'
import type { KnowledgeCaller, ProjectStores } from '../interfaces.js'
import { FsEventStore } from '../store/fs-events.js'
import { withLock } from '../store/locks.js'
import {
  writeFileAtomic,
  readJsonFile,
  appendLine,
  readJsonLines,
  assertNoSymlinks,
} from '../store/fs-utils.js'
export { validateSchema } from '../engine/schema.js'
export {
  assertNoSymlinks,
  writeFileAtomic,
  readJsonFile,
  readJsonLines,
  appendLine,
} from '../store/fs-utils.js'

export interface KnowledgeQueryRecord extends KnowledgeCaller {
  queryId: string
  workflowId?: string
  at: string
  text: string
  intent?: string
  bases: Array<{ id: string; version: number }>
  top: Array<Pick<KnowledgeHit, 'baseId' | 'ref' | 'score' | 'rank' | 'version'>>
  latencyMs: number
  tokens: number
  type?: 'query' | 'used'
  refs?: string[]
}
export async function readKnowledgeQueries(stores: ProjectStores): Promise<KnowledgeQueryRecord[]> {
  const file = join(stores.taktDir, 'knowledge/queries.jsonl')
  await assertNoSymlinks(stores.taktDir, file)
  let content: string
  try {
    content = await readFile(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  return content.split('\n').flatMap((line) => {
    try {
      const row = JSON.parse(line) as KnowledgeQueryRecord
      return typeof row.queryId === 'string' && Array.isArray(row.top) && Array.isArray(row.bases)
        ? [row]
        : []
    } catch {
      return []
    }
  })
}
export const appendKnowledgeQuery = async (stores: ProjectStores, record: KnowledgeQueryRecord) => {
  const file = join(stores.taktDir, 'knowledge/queries.jsonl')
  await assertNoSymlinks(stores.taktDir, file)
  await appendLine(
    file,
    JSON.stringify({
      ...record,
      top:
        record.type === 'used'
          ? []
          : record.top.map(({ baseId, ref, score, rank, version }) => ({
              baseId,
              ref,
              score,
              rank,
              version,
            })),
    }),
  )
}

// 与 server 的 spaceLock 使用相同锁文件，使 CLI 和 HTTP 配置写入互斥。
export { withFileLock as knowledgeFileLock } from '../store/file-lock.js'
import { withFileLock as knowledgeFileLock } from '../store/file-lock.js'
export async function auditKnowledge(
  stores: Pick<ProjectStores, 'taktDir'>,
  actor: Actor,
  reason: string,
  message: string,
  filename = 'space-events.jsonl',
): Promise<void> {
  if (!reason?.trim()) throw new Error('写操作必须提供 reason，请填写修改原因')
  await knowledgeFileLock(join(stores.taktDir, filename), async () => {
    const scratch = await mkdtemp(join(tmpdir(), 'takt-kb-audit-'))
    const file = join(stores.taktDir, filename),
      target = join(scratch, 'runs/space/events.jsonl')
    try {
      await mkdir(dirname(target), { recursive: true })
      try {
        await copyFile(file, target)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
      const events = new FsEventStore(scratch)
      if (!(await events.verify('space')).ok) throw new Error('空间审计链损坏，请先修复审计日志')
      await events.append('space', {
        type: 'log',
        actor,
        data: { level: 'info', message: JSON.stringify({ message, reason }) },
      })
      await writeFileAtomic(file, await readFile(target))
    } finally {
      await rm(scratch, { recursive: true, force: true })
    }
  })
}
export async function changeKnowledgeConfig(
  stores: ProjectStores,
  actor: Actor,
  reason: string,
  message: string,
  change: (config: TaktConfig) => void,
): Promise<void> {
  const file = join(stores.projectDir, 'takt.config.json')
  await knowledgeFileLock(file, async () => {
    const config = (await readJsonFile<TaktConfig>(file)) ?? structuredClone(stores.config)
    change(config)
    await auditKnowledge(stores, actor, reason, message)
    await writeFileAtomic(file, JSON.stringify(config, null, 2) + '\n')
    stores.config = config
  })
}
