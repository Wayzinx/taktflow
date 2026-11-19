import { setTimeout as sleep } from 'node:timers/promises'
import { openProject, sha256, type NodeContext, type NodeResult, type ProjectStores } from '@taktflow/core'
import { cancelTeamJob, enqueueTeamJob, teamJobs, teamNodes } from './team-hub.js'

interface TeamWorkerOptions {
  prompt: string
  harness: string
  nodeId?: string
  timeoutMs?: number
  pollMs?: number
}

type Job = Awaited<ReturnType<typeof teamJobs>>[number]
type JobRef = Pick<Job, 'id' | 'nodeId' | 'harness'>
const active = (job: Job) => job.status === 'queued' || job.status === 'running'
const sameTarget = (job: Job, target: JobRef) => job.nodeId === target.nodeId && job.harness === target.harness
const describe = (job: JobRef) => `Team Hub jobId=${job.id} nodeId=${job.nodeId} harness=${job.harness}`
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error)

function outcome(ctx: NodeContext, ref: JobRef, job?: Job, reason?: string): NodeResult {
  const status = !reason && job?.status === 'succeeded' ? 'succeeded' : 'failed'
  const message = `${describe(ref)}: ${reason ?? job?.status}${job?.result ? `\n${job.result}` : ''}`
  ctx.log(message)
  return {
    status,
    message: status === 'failed' ? `${message}\n请人工核查远端工作目录；此运行不会重新派发。` : message,
    data: { jobId: ref.id, nodeId: ref.nodeId, harness: ref.harness, status: job?.status, result: job?.result, ...(reason ? { reason } : {}) },
  }
}

async function selectNode(stores: ProjectStores, options: TeamWorkerOptions, jobs: Job[]) {
  const load = new Map<string, number>()
  for (const job of jobs) if (active(job)) load.set(job.nodeId, (load.get(job.nodeId) ?? 0) + 1)
  const nodes = (await teamNodes(stores)).filter(node => node.online && node.harness === options.harness
    && (options.nodeId === undefined || node.id === options.nodeId))
  return nodes.sort((left, right) => (load.get(left.id) ?? 0) - (load.get(right.id) ?? 0) || left.id.localeCompare(right.id))[0]
}

async function findJob(stores: ProjectStores, ref: JobRef): Promise<Job> {
  const job = (await teamJobs(stores)).find(candidate => candidate.id === ref.id)
  if (!job || !sameTarget(job, ref)) throw new Error('Hub 作业缺失或目标冲突')
  return job
}

async function stopJob(ctx: NodeContext, stores: ProjectStores, ref: JobRef, reason: string): Promise<NodeResult> {
  let job: Job | undefined
  try {
    job = await findJob(stores, ref)
    if (active(job)) {
      ctx.log(`${describe(ref)}: ${reason}，请求取消`)
      await cancelTeamJob(stores, ref.id, reason)
      job = await findJob(stores, ref)
      if (active(job)) throw new Error('Hub 尚未确认取消')
    }
  } catch (error) {
    return outcome(ctx, ref, job, `${reason}；未确认作业已停止：${errorText(error)}`)
  }
  return outcome(ctx, ref, job, ctx.signal?.aborted ? '运行已取消' : job.status === 'succeeded' ? undefined : reason)
}

async function waitForJob(ctx: NodeContext, stores: ProjectStores, ref: JobRef, initial: Job | undefined,
  timeoutMs: number, pollMs: number): Promise<NodeResult> {
  const deadline = performance.now() + timeoutMs
  let job = initial
  let reason = '等待 Worker 结果超时'
  try {
    for (;;) {
      ctx.signal?.throwIfAborted()
      job ??= await findJob(stores, ref)
      ctx.signal?.throwIfAborted()
      if (!active(job)) return outcome(ctx, ref, job)
      const remaining = deadline - performance.now()
      if (remaining <= 0) break
      await sleep(Math.min(pollMs, remaining), undefined, { signal: ctx.signal })
      job = undefined
    }
  } catch (error) {
    reason = ctx.signal?.aborted ? '运行已取消' : `读取 Worker 结果失败：${errorText(error)}`
  }
  return stopJob(ctx, stores, ref, reason)
}

export async function runTeamWorker(ctx: NodeContext, options: TeamWorkerOptions): Promise<NodeResult> {
  const { harness, nodeId, prompt, timeoutMs = 15 * 60_000, pollMs = 1_000 } = options
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 60 * 60_000 || !Number.isSafeInteger(pollMs) || pollMs <= 0) {
    throw new Error('Team Hub 要求 timeoutMs 为 1 到 3600000 毫秒，pollMs 为正整数')
  }
  const stores = await openProject(ctx.projectDir)
  const run = await stores.runs.get(ctx.runId)
  if (!run || run.requirementId !== ctx.requirementId) throw new Error(`Team Hub 无法确认运行归属：${ctx.runId}`)
  // workflow- 与聊天派发的 team- 不共用命名空间；重试不把 attempt、prompt 或机器写进键。
  const id = `workflow-${sha256(JSON.stringify([run.runId, ctx.nodeId, ctx.iteration ?? null]))}`
  const jobs = await teamJobs(stores)
  const existing = jobs.find(job => job.id === id)
  if (existing) {
    if (existing.harness !== harness || (nodeId !== undefined && existing.nodeId !== nodeId)) {
      const message = `Team Hub jobId=${id} 与已存在的作业目标冲突；未接管、取消或重新派发。`
      ctx.log(message)
      return { status: 'failed', message }
    }
    ctx.log(`${describe(existing)}: 继续观察已存在作业`)
    return waitForJob(ctx, stores, existing, existing, timeoutMs, pollMs)
  }

  ctx.signal?.throwIfAborted()
  const node = await selectNode(stores, options, jobs)
  ctx.signal?.throwIfAborted()
  if (!node) {
    const message = nodeId === undefined ? `没有在线且支持 ${harness} 的 Worker` : `Worker ${nodeId} 不在线或不支持 ${harness}`
    ctx.log(message)
    return { status: 'blocked', message }
  }
  const ref = { id, nodeId: node.id, harness }
  const actorId = run.origin?.by.type === 'human' ? run.origin.by.id : `workflow:${run.workflowId}`
  try {
    const enqueued = await enqueueTeamJob(stores, { ...ref, prompt, actorId })
    if (enqueued.id !== id) throw new Error('Hub 返回了不同的作业 ID')
  } catch (error) {
    ctx.signal?.throwIfAborted()
    const message = `${describe(ref)}: 派发未确认：${errorText(error)}；未改派。`
    ctx.log(message)
    return { status: 'failed', message }
  }
  ctx.log(`${describe(ref)}: 已提交；等待远端结果，不同步文件。`)
  return waitForJob(ctx, stores, ref, undefined, timeoutMs, pollMs)
}
