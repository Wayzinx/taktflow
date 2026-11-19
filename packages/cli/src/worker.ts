import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { UsageError, type ParsedCli } from './args.js'
import { localCodex, type WorkerOutcome } from './worker-harness.js'

interface WorkerOptions { hub: string; space: string; node: string; harness: string; project: string; token: string }
interface Job { id: string; claimId: string; prompt: string }
type Call = (action: 'poll' | 'heartbeat' | 'finish', payload: object, signal?: AbortSignal, timeout?: number) => Promise<unknown>
type Report = (message: string) => void
const POLL_MS = 2000
const HEARTBEAT_MS = 5000
const REQUEST_MS = 4000
const REPLY_BYTES = 400 * 1024

class RemoteError extends Error {
  constructor(readonly status: number, action: string) { super(`Team Worker ${action} 失败（HTTP ${status}）`) }
  get retryable(): boolean { return this.status === 408 || this.status === 429 || this.status >= 500 }
}

const retryable = (error: unknown) => error instanceof RemoteError && error.retryable
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const id = (value: string) => /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)
const validToken = (token: string) => /^[A-Za-z0-9_-]{32,256}$/.test(token)

function endpoint({ hub, space, node, token }: WorkerOptions): URL {
  let url: URL
  try { url = new URL(hub) } catch { throw new UsageError('--hub 必须是 HTTP(S) URL') }
  const loopback = url.hostname === '127.0.0.1' || url.hostname === '[::1]'
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) || url.username || url.password || url.search || url.hash) {
    throw new UsageError('--hub 必须用 HTTPS，或使用指向本机隧道的 HTTP（127.0.0.1 / [::1]），且不含凭据、query 或 fragment')
  }
  if (url.protocol === 'https:' && process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0') throw new UsageError('Team Worker 要求启用 TLS 证书验证')
  if (!id(space) || !id(node) || !validToken(token)) throw new UsageError('空间、节点 ID 或 Worker token 不合法')
  url.pathname = `${url.pathname.replace(/\/$/, '')}/api/team-worker/v1/${space}/${node}/`
  return url
}

function connection(url: URL, { token, harness }: WorkerOptions): Call {
  const session = randomUUID()
  return async (action, payload, signal, timeout = REQUEST_MS) => {
    const requestTimeout = AbortSignal.timeout(timeout)
    const combined = signal ? AbortSignal.any([signal, requestTimeout]) : requestTimeout
    let response: Response
    try {
      response = await fetch(new URL(action, url), {
        method: 'POST', redirect: 'manual', signal: combined,
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ ...payload, session, harness }),
      })
    } catch { throw new RemoteError(503, action) }
    if (!response.ok) {
      void response.body?.cancel().catch(() => {})
      throw new RemoteError(response.status, action)
    }
    return readReply(response, action)
  }
}

async function readReply(response: Response, action: string): Promise<unknown> {
  const reader = response.body?.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  if (reader) for (;;) {
    const { done, value } = await reader.read().catch(() => { throw new RemoteError(503, action) })
    if (done) break
    size += value.byteLength
    if (size > REPLY_BYTES) {
      void reader.cancel().catch(() => {})
      throw new Error('Team Worker 响应过大')
    }
    chunks.push(value)
  }
  try { return JSON.parse(Buffer.concat(chunks, size).toString('utf8')) as unknown }
  catch { throw new Error(`Team Worker ${action} 响应不是 JSON`) }
}

function assignment(value: unknown): Job | null {
  const job = record(value) && value.job
  if (job === null) return null
  if (!record(job) || typeof job.id !== 'string' || !id(job.id) || typeof job.claimId !== 'string' || !id(job.claimId)
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
  const call = connection(endpoint(options), options)
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
  const stop = new AbortController()
  const abort = () => stop.abort()
  process.once('SIGINT', abort)
  process.once('SIGTERM', abort)
  try {
    await runTeamWorker({ hub, space, node: node[0]!, harness, project, token }, stop.signal,
      (message) => { process.stderr.write(`${message}\n`) })
    return 0
  } finally {
    process.off('SIGINT', abort)
    process.off('SIGTERM', abort)
  }
}
