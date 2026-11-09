import { mkdir, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import type { ProjectStores } from '../interfaces.js'
import type { RunState } from '../types.js'
import { runDir } from '../store/paths.js'
import { acquireProcessFile, ownerIsDead, readProcessOwner } from '../store/process-file.js'

export async function withRunLease<T>(stores: ProjectStores, runId: string, fn: () => Promise<T>): Promise<T> {
  const dir = runDir(stores.taktDir, runId)
  await mkdir(dir, { recursive: true })
  // 符号链接别名也必须共享回收锁身份。
  const acquired = await acquireProcessFile(join(await realpath(dir), 'lease.json'), { startedAt: new Date().toISOString() })
  if (!('release' in acquired)) throw new Error(`运行正在由进程 ${acquired.owner.pid ?? '未知'} 执行`)
  try { return await fn() } finally { await acquired.release() }
}

export async function runLiveness(stores: ProjectStores, runId: string, state?: Pick<RunState, 'status'>): Promise<'active' | 'interrupted' | 'idle'> {
  state ??= await stores.runs.get(runId)
  if (state?.status !== 'running') return 'idle'
  const owner = await readProcessOwner(join(runDir(stores.taktDir, runId), 'lease.json'))
  return owner === undefined || ownerIsDead(owner) ? 'interrupted' : 'active'
}
