import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { UsageError, type ParsedCli } from './args.js'
import { localCodex, type WorkerOutcome } from './worker-harness.js'
import { postTeamJson, record, RemoteError, REQUEST_MS, teamEndpoint, teamId, validToken, type TeamDestination } from './team-transport.js'

interface WorkerOptions extends TeamDestination { harness: string; project: string; token: string }
interface Job { id: string; claimId: string; prompt: string }
type Call = (action: 'poll' | 'heartbeat' | 'finish', payload: object, signal?: AbortSignal, timeout?: number) => Promise<unknown>
type Report = (message: string) => void
const POLL_MS = 2000
const HEARTBEAT_MS = 5000
const retryable = (error: unknown) => error instanceof RemoteError && error.retryable

function connection(url: URL, { token, harness }: WorkerOptions): Call {
  const session = randomUUID()
  return (action, payload, signal, timeout) => postTeamJson(url, action, { ...payload, session, harness }, { token, signal, timeout })
}

function assignment(value: unknown): Job | null {
  const job = record(value) && value.job
  if (job === null) return null
  if (!record(job) || typeof job.id !== 'string' || !teamId(job.id) || typeof job.claimId !== 'string' || !teamId(job.claimId)
    || typeof job.prompt !== 'string' || Buffer.byteLength(job.prompt) > 64 * 1024) throw new Error('Team Worker 任务响应不合法')
  return { id: job.id, claimId: job.claimId, prompt: job.prompt }
}

async function renew(call: Call, job: object, signal: AbortSignal, deadline: number): Promise<number> {
  for (;;) {
    const sent = performance.now()
    const left = Math.floor(deadline - sent)
    if (left <= 0 || signal.aborted) throw new Error('无法确认任务租约')
    try {
      const ack = await call('heartbeat', job, signal, Math.min(left, REQUEST_MS))
      if (!record(ack) || typeof ack.leaseMs !== 'number' || !Number.isSafeInteger(ack.leaseMs) || ack.leaseMs < 10_000 || ack.leaseMs > 60_000) {
        throw new Error('Team Worker 租约响应不合法')
      }
      const expires = sent + ack.leaseMs - 1000
      if (expires <= performance.now()) throw new Error('租约响应到达时已过期')
      return expires
    } catch (error) {
      if (!retryable(error) || signal.aborted) throw error
      await delay(Math.min(1000, Math.max(0, deadline - performance.now())), undefined, { signal })
    }
  }
}

async function finish(call: Call, payload: object, stop: AbortSignal, report: Report): Promise<void> {
  const deadline = performance.now() + 20_000
  for (;;) {
    try {
      const ack = await call('finish', payload)
      if (!record(ack) || ack.ok !== true) throw new Error('Team Worker 完成响应不合法')
      return
    } catch (error) {
      if (error instanceof RemoteError && error.status === 409) {
        report('任务认领已失效；请检查工作目录，Worker 不会重跑。')
        return
      }
      if (!retryable(error) || stop.aborted || performance.now() >= deadline) {
        throw new Error('无法确认任务结果是否送达；Worker 已停止且不会重跑，请检查 Hub 与工作目录。', { cause: error })
      }
      await delay(1000, undefined, { signal: stop }).catch(() => {})
    }
  }
}

async function runJob(call: Call, job: Job, run: Awaited<ReturnType<typeof localCodex>>, stop: AbortSignal, report: Report): Promise<void> {
  const claim = { id: job.id, claimId: job.claimId }
  let expires: number
  try { expires = await renew(call, claim, stop, performance.now() + 15_000) } catch (error) {
    await finish(call, { ...claim, status: 'failed', result: '无法确认任务租约，未启动 Codex。' }, stop, report)
    if (!stop.aborted) report(error instanceof Error ? error.message : '无法确认任务租约')
    return
  }
  const watch = new AbortController()
  const signal = AbortSignal.any([watch.signal, stop])
  const leaseLost = new AbortController()
  const keepalive = (async () => {
    try {
      for (;;) {
        await delay(Math.min(HEARTBEAT_MS, Math.max(0, expires - performance.now())), undefined, { signal })
        expires = await renew(call, claim, signal, expires)
      }
    } catch { if (!signal.aborted) leaseLost.abort() }
  })()
  let outcome: WorkerOutcome
  try { outcome = await run(job.prompt, AbortSignal.any([signal, leaseLost.signal])) }
  finally { watch.abort(); await keepalive }
  await finish(call, { ...claim, ...outcome }, stop, report)
}

export async function runTeamWorker(options: WorkerOptions, stop: AbortSignal, report: Report = () => {}): Promise<void> {
  if (options.harness !== 'codex') throw new UsageError('Team Worker 目前只支持 --harness codex')
  const endpoint = teamEndpoint(options)
  if (!validToken(options.token)) throw new UsageError('Worker token 不合法')
  const call = connection(endpoint, options)
  const run = await localCodex(options.project)
  let poll = 1
  let disconnected = false
  while (!stop.aborted) {
    let job: Job | null
    try { job = assignment(await call('poll', { poll }, stop)) } catch (error) {
      if (stop.aborted) return
      if (!retryable(error)) throw error
      if (!disconnected) report('暂时无法连到 Team Hub；将重试同一次轮询。')
      disconnected = true
      await delay(POLL_MS, undefined, { signal: stop }).catch(() => {})
      continue
    }
    disconnected = false
    poll++
    if (job) await runJob(call, job, run, stop, report)
    else await delay(POLL_MS, undefined, { signal: stop }).catch(() => {})
  }
}

async function readToken(): Promise<string> {
  if (process.stdin.isTTY) throw new UsageError('从标准输入传入单个 Worker token（不要放在命令行或环境变量中）')
  let token = ''
  for await (const chunk of process.stdin) {
    token += String(chunk)
    if (token.length > 258) throw new UsageError('Worker token 不合法')
  }
  return token.replace(/\r?\n$/, '')
}

export async function runWorkerCommand({ options, positionals }: ParsedCli): Promise<number> {
  const { hub, space, node, harness, project } = options
  if (positionals.length || !hub || !space || node?.length !== 1 || !harness || !project) {
    throw new UsageError('用法：takt worker --hub URL --space ID --node ID --harness codex --project DIR（token 从 stdin 读入）')
  }
  const token = await readToken()
  return withWorkerSignals(async ({ signal }) => {
    await runTeamWorker({ hub, space, node: node[0]!, harness, project, token }, signal, reportWorker)
  })
}

export const reportWorker: Report = (message) => { process.stderr.write(`${message}\n`) }

export async function withWorkerSignals(run: (stop: AbortController) => Promise<void>): Promise<number> {
  const stop = new AbortController()
  const abort = () => stop.abort()
  process.once('SIGINT', abort)
  process.once('SIGTERM', abort)
  try {
    await run(stop)
    return 0
  } catch (error) {
    if (stop.signal.aborted) return 0
    throw error
  } finally {
    process.off('SIGINT', abort)
    process.off('SIGTERM', abort)
  }
}
