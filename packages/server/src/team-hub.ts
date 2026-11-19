import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { assertNoSymlinks, readJsonFile, writeFileAtomic, type ProjectStores } from '@taktflow/core'
import { HttpError, safeId } from './http.js'
import { spaceLock } from './space-lock.js'

export const TEAM_LEASE_MS = 30_000
export const TEAM_RESULT_BYTES = 16 * 1024
const LOST = 'Worker 租约过期；未自动重试，请检查工作目录后再派发。'

interface NewJob { id: string; nodeId: string; harness: string; prompt: string; actorId: string }
type Outcome = { status: 'succeeded' | 'failed'; result: string }
interface TeamJob {
  id: string
  nodeId: string
  harness: string
  status: 'queued' | 'running' | Outcome['status']
  result?: string
}
interface Claim { id: string; session: string; expiresAt: number }
interface Job extends TeamJob, NewJob { claim?: Claim }
interface Worker { id: string; harness: string; session: string; seenAt: number; poll: number; jobId?: string }
interface State { version: 1; nodes: Worker[]; jobs: Job[] }
interface WorkerIdentity { id: string; harness: string; session: string }
interface Assignment { id: string; claimId: string; prompt: string }

function online(node: Worker, now: number): boolean { return now - node.seenAt < TEAM_LEASE_MS }

async function access<T>(stores: ProjectStores, write: boolean, fn: (state: State, now: number) => T): Promise<T> {
  const file = join(stores.taktDir, 'runs', '.team-hub', 'state.json')
  await assertNoSymlinks(stores.taktDir, file)
  return spaceLock(file, async () => {
    const state = await readJsonFile<State>(file) ?? { version: 1, nodes: [], jobs: [] }
    if (state.version !== 1 || !Array.isArray(state.nodes) || !Array.isArray(state.jobs)) throw new Error('Team Hub 存储格式不合法')
    const save = async () => {
      await mkdir(dirname(file), { recursive: true, mode: 0o700 })
      await writeFileAtomic(file, JSON.stringify(state))
    }
    const now = Date.now()
    let expired = false
    for (const job of state.jobs) if (job.status === 'running' && job.claim!.expiresAt <= now) {
      job.status = 'failed'
      job.result = LOST
      delete job.claim
      expired = true
    }
    if (expired) await save()
    const result = fn(state, now)
    if (write) await save()
    return result
  })
}

export function teamNodes(stores: ProjectStores): Promise<Array<{ id: string; harness: string; online: boolean }>> {
  return access(stores, false, (state, now) => state.nodes.map((node) => ({ id: node.id, harness: node.harness, online: online(node, now) })))
}

export function teamJobs(stores: ProjectStores): Promise<TeamJob[]> {
  return access(stores, false, (state) => state.jobs.map(({ id, nodeId, harness, status, result }) =>
    ({ id, nodeId, harness, status, ...(result === undefined ? {} : { result }) })))
}

export async function enqueueTeamJob(stores: ProjectStores, { id, nodeId, harness, prompt, actorId }: NewJob): Promise<{ id: string }> {
  teamId(id)
  teamId(nodeId)
  teamId(harness)
  if (!prompt.trim() || Buffer.byteLength(prompt) > 64 * 1024) throw new HttpError(400, '任务 prompt 必须非空且不超过 64 KiB')
  if (!actorId.trim() || Buffer.byteLength(actorId) > 256) throw new HttpError(400, '任务 actorId 不合法')
  return access(stores, true, (state, now) => {
    const existing = state.jobs.find((job) => job.id === id)
    if (existing) {
      if (existing.nodeId !== nodeId || existing.harness !== harness || existing.prompt !== prompt || existing.actorId !== actorId) {
        throw new HttpError(409, '任务 ID 已用于不同任务')
      }
      return { id }
    }
    const node = state.nodes.find((node) => node.id === nodeId)
    if (!node || !online(node, now) || node.harness !== harness) throw new HttpError(409, 'Worker 离线或 harness 不匹配')
    state.jobs.push({ id, nodeId, harness, prompt, actorId, status: 'queued' })
    return { id }
  })
}

/** 周期内的 heartbeat 会通知执行端停止；已完成的回执保持原样。 */
export function cancelTeamJob(stores: ProjectStores, id: string, reason: string): Promise<void> {
  return access(stores, true, state => {
    const job = state.jobs.find(item => item.id === id)
    if (!job) throw new HttpError(404, '作业不存在')
    if (job.status === 'queued' || job.status === 'running') {
      job.status = 'failed'
      job.result = reason
    }
  })
}

export function teamId(value: string): string {
  if (value.length > 128) throw new HttpError(400, 'Team Hub ID 过长')
  return safeId(value)
}

export function pollTeamJob(stores: ProjectStores, worker: WorkerIdentity, poll: number): Promise<{ job: Assignment | null }> {
  return access(stores, true, (state, now) => {
    const node = state.nodes.find((node) => node.id === worker.id)
    const same = node?.session === worker.session && node.harness === worker.harness ? node : undefined
    if (node && online(node, now) && !same) throw new HttpError(409, '此 Worker 节点已有活跃进程')
    if (same && poll === same.poll) {
      const job = state.jobs.find((job) => job.id === same.jobId && job.status === 'running')
      same.seenAt = now
      return { job: job ? { id: job.id, claimId: job.claim!.id, prompt: job.prompt } : null }
    }
    if (poll !== (same?.poll ?? 0) + 1) throw new HttpError(409, 'Worker 轮询序号不合法')
    if (state.jobs.some((job) => job.nodeId === worker.id && job.status === 'running')) throw new HttpError(409, '上一个任务尚未结束')
    const job = state.jobs.find((job) => job.nodeId === worker.id && job.harness === worker.harness && job.status === 'queued')
    const updated: Worker = { ...worker, seenAt: now, poll, jobId: job?.id }
    if (node) Object.assign(node, updated)
    else state.nodes.push(updated)
    if (!job) return { job: null }
    const claimId = randomUUID()
    job.status = 'running'
    job.claim = { id: claimId, session: worker.session, expiresAt: now + TEAM_LEASE_MS }
    return { job: { id: job.id, claimId, prompt: job.prompt } }
  })
}

export function updateTeamClaim(stores: ProjectStores, worker: WorkerIdentity, id: string, claimId: string, outcome?: Outcome): Promise<{ ok: true }> {
  return access(stores, true, (state, now) => {
    const job = state.jobs.find((job) => job.id === id && job.nodeId === worker.id && job.harness === worker.harness)
    if (!job?.claim || job.claim.id !== claimId || job.claim.session !== worker.session) throw new HttpError(409, 'Worker 任务认领不匹配')
    if (job.status !== 'running') {
      if (outcome && outcome.status === job.status && outcome.result === job.result) return { ok: true }
      throw new HttpError(409, 'Worker 任务认领已结束')
    }
    state.nodes.find((node) => node.id === worker.id)!.seenAt = now
    if (outcome) Object.assign(job, outcome)
    else job.claim.expiresAt = now + TEAM_LEASE_MS
    return { ok: true }
  })
}
