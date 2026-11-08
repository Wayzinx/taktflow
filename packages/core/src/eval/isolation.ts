import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative, isAbsolute } from 'node:path'
import type { EngineDeps } from '../interfaces.js'
import type { CheckpointRole, EvalRun, HarnessAdapter, Sandbox } from '../types.js'
import { executionAdapters } from '../engine/execution.js'

export const replayRoles = new Set<CheckpointRole>(['reviewer', 'arbiter', 'rubric', 'auditor', 'evaluator'])
export function assertReplayRole(role: CheckpointRole): void {
  if (!replayRoles.has(role)) throw new Error(`检查点 ${role} 不是只读检查点；本期不支持写代码或整节点回放，请选择评审者、裁决者、rubric、auditor 或 evaluator`)
}

export function checkReplayIsolation(harness: HarnessAdapter, cwd: string, sandbox?: Sandbox): NonNullable<EvalRun['isolation']> {
  if (harness.id === 'mock') return { ok: true, mode: 'simulated', reasons: ['mock 模拟隔离，仅用于测试和演示，不能作为真实隔离或发布证明'] }
  if (harness.capabilities?.readOnly === true) return { ok: true, mode: 'harness_readonly' }
  const reasons: string[] = []
  if (!sandbox || !['bwrap', 'docker'].includes(sandbox.provider)) reasons.push('需要 bwrap / docker 沙箱，或声明 readOnly 能力的 harness')
  if (!harness.capabilities?.sandbox) reasons.push('harness 未声明支持沙箱，不能保证调用在隔离环境内执行')
  if (sandbox?.spec.network !== 'none') reasons.push('回放必须关闭网络，请将沙箱网络设为 none')
  if (!sandbox?.spec.mounts.some(mount => mount.source === cwd && mount.target === cwd && mount.mode === 'ro')) reasons.push('快照及候选材料必须完整只读挂载，请检查沙箱挂载')
  if (sandbox?.spec.mounts.some(mount => {
    const path = relative(cwd, mount.source)
    return mount.mode !== 'ro' || path.startsWith('..') || isAbsolute(path)
  })) reasons.push('沙箱包含可写或临时环境之外的挂载，请移除额外挂载')
  if (sandbox && sandbox.spec.workdir !== cwd) reasons.push('沙箱工作目录不属于本次独立环境，请检查 provider')
  return { ok: reasons.length === 0, ...(reasons.length ? {} : { mode: 'sandbox' as const }), reasons }
}

export async function replaySandbox(deps: EngineDeps, harness: HarnessAdapter, cwd: string): Promise<Sandbox | undefined> {
  if (harness.id === 'mock' || harness.capabilities?.readOnly) return undefined
  const provider = deps.sandbox ?? await (await executionAdapters()).selectSandboxProvider(deps.stores.config.sandbox)
  const ready = await provider.available()
  if (!ready.ok) throw new Error(`回放沙箱不可用：${ready.reason ?? provider.id}；请修复沙箱后重试`)
  return provider.create({ workdir: cwd, mounts: [{ source: cwd, target: cwd, mode: 'ro' }], network: 'none',
    image: deps.stores.config.sandbox?.image, limits: { timeoutMs: 120000 } })
}

export async function preflightIsolation(deps: EngineDeps, harness: HarnessAdapter): Promise<NonNullable<EvalRun['isolation']>> {
  const cwd = await mkdtemp(join(tmpdir(), 'takt-replay-preflight-'))
  let sandbox: Sandbox | undefined
  try {
    const available = await harness.available()
    if (!available.ok) return { ok: false, reasons: [`harness 不可用：${available.reason ?? harness.id}；请修复后重试`] }
    sandbox = await replaySandbox(deps, harness, cwd)
    return checkReplayIsolation(harness, cwd, sandbox)
  } catch (error) { return { ok: false, reasons: [error instanceof Error ? error.message : String(error)] } }
  finally { try { await sandbox?.dispose() } finally { await rm(cwd, { recursive: true, force: true }) } }
}
