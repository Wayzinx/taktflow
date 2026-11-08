import { randomUUID } from 'node:crypto'
import type { EngineDeps } from '../interfaces.js'
import type { AgentProfile, CheckpointRole, HarnessEvent, HarnessResult, HarnessSelector, Invocation, InvocationEnd, InvocationStart } from '../types.js'
import { resolveHarnessSelector } from '../engine/selection.js'
import { loadedSkills } from '../engine/recipe.js'
import { mergeInvocation } from '../engine/invocations.js'
import { checkReplayIsolation, replaySandbox } from './isolation.js'
import { qualityStore } from './quality-access.js'

export async function callReadOnly(deps: EngineDeps, input: { cwd: string; prompt: string; profile: AgentProfile; selector: HarnessSelector;
  role: CheckpointRole; checkpointId?: string; recipeKey: string; schema?: Record<string, unknown>; runId?: string; fallbackIndex?: number; onInvocation?: (value: Invocation) => void }) {
  const { harness, model, provider, modelConfig } = resolveHarnessSelector(input.selector, deps.stores.config, deps.harnesses)
  const sandbox = await replaySandbox(deps, harness, input.cwd)
  try {
    const isolation = checkReplayIsolation(harness, input.cwd, sandbox)
    if (!isolation.ok) throw new Error(isolation.reasons!.join('；'))
    const skills = await loadedSkills(input.cwd, harness.id)
    const start: InvocationStart = { id: randomUUID(), nodeId: input.role, attempt: 1, checkpointId: input.checkpointId, role: input.role,
      agentRole: input.profile.role, fallbackIndex: input.fallbackIndex ?? 0, recipeKey: input.recipeKey, harness: harness.id, readOnly: true, at: new Date().toISOString(),
      model: { requested: input.selector.model, resolved: model, applied: harness.capabilities?.modelOverride },
      effort: { requested: input.selector.effort, resolved: input.selector.effort, applied: harness.capabilities?.effortOverride },
      skills: input.profile.skills.map(name => ({ name, providedHash: skills.find(s => s.name === name)?.hash, confirmed: 'unknown' })) }
    const actor = { type: 'agent' as const, role: input.profile.role, harness: harness.id, invocationId: start.id }
    const audit = (kind: 'invocation.started' | 'invocation.finished', invocation: InvocationStart | InvocationEnd) => qualityStore(deps.stores).append([{ kind,
      key: `eval:${kind}:${start.id}`, actor, data: { ...invocation, runId: input.runId,
        reason: '只读回放调用身份与实际回报留痕' } }])
    await audit('invocation.started', start)
    const began = Date.now()
    let reported: InvocationEnd['reported'], result: HarnessResult | undefined, failure: unknown
    const env: Record<string, string> = { TAKT_ROLE: input.profile.role, TAKT_NODE: input.role, TAKT_WORKSPACE: input.cwd }
    if (provider?.apiKeyEnv && process.env[provider.apiKeyEnv]) env[provider.apiKeyEnv] = process.env[provider.apiKeyEnv]!
    try {
      result = await harness.run({ cwd: input.cwd, prompt: input.prompt, systemAppend: input.profile.instructions, model, modelConfig, provider,
        effort: input.selector.effort, readOnly: true, tools: { writeScope: [], allowBash: false }, sandbox, env,
        resultSchema: input.schema, timeoutMs: 120000, signal: AbortSignal.timeout(120000) }, (event: HarnessEvent) => {
        if (event.type === 'started') reported = { model: event.model, effort: event.effort, skills: event.skills }
      })
      if (!result.ok) failure = new Error(`只读调用失败：${result.error ?? result.finalText}；请检查 harness 后重试`)
    } catch (error) { failure = error }
    const end: InvocationEnd = { id: start.id, outcome: failure ? 'error' : 'ok', error: failure ? String(failure) : undefined,
      reported, usage: result?.usage, sessionId: result?.sessionId, durationMs: Date.now() - began }
    await audit('invocation.finished', end)
    input.onInvocation?.(mergeInvocation(start, end))
    if (failure) throw Object.assign(new Error(failure instanceof Error ? failure.message : String(failure)), { invocationId: start.id })
    return { result: result!, invocation: mergeInvocation(start, end), isolation }
  } finally { await sandbox?.dispose() }
}
