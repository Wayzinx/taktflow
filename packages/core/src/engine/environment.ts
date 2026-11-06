import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import type { NodeContext, NodeResult } from '../types.js'
import { readJsonFile, writeFileAtomic } from '../store/fs-utils.js'
import { runDir } from '../store/paths.js'
import { command, outputTail } from './process.js'
import { environmentConfig, environmentVariables, type EnvironmentConfig } from './environment-config.js'

interface Lifecycle { cwd?: string; setup?: 'started' | 'succeeded' | 'failed'; tornDown?: boolean }
interface CommandEvidence { command: string; code: number; durationMs: number; output: string; timedOut?: boolean; cancelled?: boolean }
interface HealthEvidence { status: 'passed' | 'failed' | 'skipped'; url?: string; durationMs: number; timedOut?: boolean; cancelled?: boolean; probes: CommandEvidence[] }
interface Deployment { ok: boolean; evidence: string }
const lifecycleFile = (ctx: NodeContext) => join(runDir(join(ctx.projectDir, '.takt'), ctx.runId), 'environment.json')
const lifecycle = async (ctx: NodeContext): Promise<Lifecycle> => await readJsonFile<Lifecycle>(lifecycleFile(ctx)) ?? {}
const saveLifecycle = (ctx: NodeContext, state: Lifecycle) => writeFileAtomic(lifecycleFile(ctx), JSON.stringify(state))
const directory = (ctx: NodeContext) => (ctx.resultOf('integration') as { path?: string } | undefined)?.path ?? ctx.projectDir
const evidenceFile = (ctx: NodeContext) => `evidence/env/round-${ctx.iteration ?? 1}.json`
const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`
const message = (error: unknown) => error instanceof Error ? error.message : String(error)

export async function hasEnvironment(ctx: NodeContext): Promise<boolean> { return Boolean(await environmentConfig(ctx)) }
export async function hasEnvironmentSetup(ctx: NodeContext): Promise<boolean> { return Boolean((await environmentConfig(ctx))?.setup) }
export async function hasEnvironmentTeardown(ctx: NodeContext): Promise<boolean> { return Boolean((await environmentConfig(ctx))?.teardown) }

async function measured(text: string, cwd: string, vars: ReturnType<typeof environmentVariables>, signal?: AbortSignal): Promise<CommandEvidence> {
  const start = Date.now()
  let output = ''
  try {
    const result = await command(text, cwd, vars.env, signal, { ...vars, onOutput: (tail) => { output = tail } })
    return { command: vars.redact(text), ...result, durationMs: Date.now() - start }
  } catch (error) {
    return { command: vars.redact(text), code: -1, durationMs: Date.now() - start,
      output: outputTail(vars.redact(`${output}\n${message(error)}`)),
      timedOut: signal?.aborted && signal.reason?.name === 'TimeoutError', cancelled: signal?.aborted }
  }
}

async function checkHealth(config: EnvironmentConfig, ctx: NodeContext, cwd: string, vars: ReturnType<typeof environmentVariables>): Promise<HealthEvidence> {
  const health = config.healthcheck
  if (!health) return { status: 'skipped', durationMs: 0, probes: [] }
  const start = Date.now()
  const timeout = AbortSignal.timeout(health.timeoutMs ?? 120_000)
  const signal = ctx.signal ? AbortSignal.any([ctx.signal, timeout]) : timeout
  // URL 探测也放进进程组，使超时和取消能统一终止检查及其子进程。
  const text = health.command ?? `${quote(process.execPath)} -e ${quote("fetch(process.env.TAKT_ENV_URL).then(async r=>{console.log('HTTP '+r.status);await r.body?.cancel();process.exit(r.ok?0:1)}).catch(e=>{console.error(e.message);process.exit(1)})")}`
  const result: HealthEvidence = { status: 'failed', url: health.url && vars.redact(health.url), durationMs: 0, probes: [] }
  while (!signal.aborted) {
    const probe = await measured(text, cwd, vars, signal)
    result.probes.push(probe)
    if (probe.code === 0 && !signal.aborted) { result.status = 'passed'; break }
    if (!signal.aborted) await delay(Math.min(2000, Math.max(1, (health.timeoutMs ?? 120_000) - (Date.now() - start))), undefined, { signal }).catch(() => {})
  }
  result.durationMs = Date.now() - start
  result.timedOut = timeout.aborted
  result.cancelled = ctx.signal?.aborted ?? false
  return result
}

export async function setupEnvironment(ctx: NodeContext): Promise<NodeResult | void> {
  const config = await environmentConfig(ctx)
  if (!config?.setup) return
  const state = await lifecycle(ctx)
  if (state.setup === 'succeeded') return
  if (state.setup) return { status: 'failed', message: '本运行的环境准备已失败或中断，不重复执行一次性准备' }
  state.cwd = directory(ctx)
  state.setup = 'started'
  state.tornDown = false
  await saveLifecycle(ctx, state)
  const result = await measured(config.setup, state.cwd, environmentVariables(config, ctx), ctx.signal)
  state.setup = result.code === 0 ? 'succeeded' : 'failed'
  await saveLifecycle(ctx, state)
  ctx.log(`环境准备：${JSON.stringify(result)}`)
  ctx.signal?.throwIfAborted()
  if (result.code !== 0) return { status: 'failed', message: `环境准备失败，退出码 ${result.code}` }
}

export async function deployEnvironment(ctx: NodeContext): Promise<NodeResult | void> {
  const config = await environmentConfig(ctx)
  if (!config) return
  const state = await lifecycle(ctx)
  state.cwd = directory(ctx)
  state.tornDown = false
  await saveLifecycle(ctx, state)
  const evidence = evidenceFile(ctx)
  const start = Date.now()
  const attempts: Array<{ deploy: CommandEvidence; healthcheck: HealthEvidence }> = []
  let ok = false
  let error: string | undefined
  try {
    const vars = environmentVariables(config, ctx)
    for (let attempt = 1; attempt <= 2; attempt++) {
      const deploy = await measured(config.deploy, state.cwd, vars, ctx.signal)
      const healthcheck = deploy.code === 0 && !ctx.signal?.aborted
        ? await checkHealth(config, ctx, state.cwd, vars) : { status: 'skipped' as const, durationMs: 0, probes: [] }
      attempts.push({ deploy, healthcheck })
      ok = deploy.code === 0 && healthcheck.status !== 'failed' && !ctx.signal?.aborted
      if (ok || ctx.signal?.aborted) break
      if (attempt === 1) ctx.log('环境部署或就绪检查失败，自动重试一次')
    }
  } catch (failure) {
    // 变量解析只报告缺少的变量名，不包含配置值。
    error = message(failure)
  }
  await writeFileAtomic(join(ctx.workspaceDir, evidence), JSON.stringify({ runId: ctx.runId, round: ctx.iteration ?? 1,
    ok, durationMs: Date.now() - start, attempts, error }, null, 2))
  ctx.log(`环境${ok ? '就绪' : '失败'}：${evidence}`)
  ctx.signal?.throwIfAborted()
  return { data: { ok, evidence } satisfies Deployment }
}

export async function environmentFailure(ctx: NodeContext): Promise<NodeResult | undefined> {
  const result = ctx.resultOf('deploy-env') as Deployment | undefined
  if (!result || result.ok) return
  const failure = { subject: 'environment', status: 'error', evidence: result.evidence }
  await writeFileAtomic(join(ctx.workspaceDir, 'evidence/summary.json'), JSON.stringify({ cases: [{ id: 'environment', ...failure }] }, null, 2))
  return { data: { total: 0, failures: [failure] } }
}

export async function runEnvironmentCaseCommand(ctx: NodeContext, cwd: string, text: string): Promise<void> {
  const vars = environmentVariables(await environmentConfig(ctx), ctx)
  const result = await measured(text, cwd, vars, ctx.signal)
  ctx.signal?.throwIfAborted()
  if (result.output) ctx.log(result.output)
  if (result.code !== 0) ctx.log(`用例命令退出非零：${result.code}（用例结论以本轮汇总为准）`)
}

export async function teardownEnvironment(ctx: NodeContext): Promise<void> {
  const config = await environmentConfig(ctx)
  if (!config?.teardown) return
  const state = await lifecycle(ctx)
  if (state.tornDown) return
  try {
    const signal = ctx.signal ? AbortSignal.any([ctx.signal, AbortSignal.timeout(120_000)]) : AbortSignal.timeout(120_000)
    const result = await measured(config.teardown, state.cwd ?? directory(ctx), environmentVariables(config, ctx), signal)
    ctx.log(`环境回收${result.code === 0 ? '完成' : '失败（仅记录）'}：${JSON.stringify(result)}`)
    // 正常节点被取消后由引擎使用独立信号补做回收。
    ctx.signal?.throwIfAborted()
  } catch (error) {
    ctx.signal?.throwIfAborted()
    ctx.log(`环境回收失败（仅记录）：${message(error)}`)
  }
  state.tornDown = true
  await saveLifecycle(ctx, state)
}
