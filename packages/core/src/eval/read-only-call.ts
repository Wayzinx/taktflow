import { resolveSecret } from '../secrets/index.js'
import { randomUUID } from 'node:crypto'
import type { EngineDeps } from '../interfaces.js'
import type { AgentProfile, CheckpointRole, HarnessEvent, HarnessRequest, HarnessResult, HarnessSelector, Invocation, InvocationEnd, InvocationStart, EventType, EventPayloads } from '../types.js'
import { resolveHarnessSelector } from '../engine/selection.js'
import { loadedSkills } from '../engine/recipe.js'
import { mergeInvocation } from '../engine/invocations.js'
import { runStructured } from '../engine/structured.js'
import { FailureError } from '../engine/fingerprint.js'
import { collectSecrets, createRedactor, redactValue } from '../util/redact.js'
import { estimateTokens } from '../util/tokens.js'
import { checkReplayIsolation, replaySandbox } from './isolation.js'
import { qualityStore } from './quality-access.js'

export async function callReadOnly(deps: EngineDeps, input: { cwd: string; prompt: string; profile: AgentProfile; selector: HarnessSelector;
  role: CheckpointRole; checkpointId?: string; recipeKey: string; schema?: Record<string, unknown>; runId?: string; fallbackIndex?: number; onInvocation?: (value: Invocation) => void; validate?: (data: unknown) => string[] }) {
  const { harness, model, provider, modelConfig, pairing } = resolveHarnessSelector(input.selector, deps.stores.config, deps.harnesses, deps.bridge)
  const sandbox = await replaySandbox(deps, harness, input.cwd)
  let route: Awaited<ReturnType<NonNullable<EngineDeps['bridge']>['open']>> | undefined
  try {
    const isolation = checkReplayIsolation(harness, input.cwd, sandbox)
    if (!isolation.ok) throw new Error(isolation.reasons!.join('；'))
    const skills = await loadedSkills(input.cwd, harness.id)
    const env: Record<string, string> = { TAKT_ROLE: input.profile.role, TAKT_NODE: input.role, TAKT_WORKSPACE: input.cwd }
    const apiKey = pairing?.mode !== 'bridge' && provider?.apiKeyEnv ? resolveSecret(provider.apiKeyEnv) : undefined
    if (provider?.apiKeyEnv && apiKey) env[provider.apiKeyEnv] = apiKey
    const request: HarnessRequest = { cwd: input.cwd, prompt: input.prompt, systemAppend: input.profile.instructions, model, modelConfig, provider,
      effort: input.selector.effort, readOnly: true, tools: { writeScope: [], allowBash: false }, sandbox, env,
      resultSchema: input.schema, timeoutMs: 120000, signal: AbortSignal.timeout(120000) }
    if (pairing?.mode === 'bridge') {
      route = await deps.bridge!.open(provider!, pairing.protocol!, { model, signal: request.signal })
      request.provider = route.provider
      Object.assign(env, route.env)
    }
    const redact = createRedactor(collectSecrets(request))
    let invocation: Invocation | undefined
    const invoke = async (req: HarnessRequest, repair = 0): Promise<HarnessResult> => {
      const start: InvocationStart = { id: randomUUID(), nodeId: input.role, attempt: 1, checkpointId: input.checkpointId, role: input.role,
        agentRole: input.profile.role, fallbackIndex: input.fallbackIndex ?? 0, recipeKey: input.recipeKey, harness: harness.id, readOnly: true, repair: repair || undefined, at: new Date().toISOString(), provider: provider?.id, pairing,
        model: { requested: input.selector.model, resolved: model, applied: harness.capabilities?.modelOverride },
        effort: { requested: input.selector.effort, resolved: input.selector.effort, applied: harness.capabilities?.effortOverride },
        skills: input.profile.skills.map(name => ({ name, providedHash: skills.find(s => s.name === name)?.hash, confirmed: 'unknown' })) }
      const actor = { type: 'agent' as const, role: input.profile.role, harness: harness.id, invocationId: start.id }
      const audit = (kind: 'invocation.started' | 'invocation.finished', value: InvocationStart | InvocationEnd) => qualityStore(deps.stores).append([{ kind,
        key: `eval:${kind}:${start.id}`, actor, data: { ...value, runId: input.runId, reason: '只读回放调用身份与实际回报留痕' } }])
      await audit('invocation.started', start)
      const began = Date.now()
      let reported: InvocationEnd['reported'], result: HarnessResult | undefined, failure: unknown, sessionId: string | undefined
      try {
        result = redactValue(await harness.run(req, (event: HarnessEvent) => {
          if (event.type === 'started') { reported = { model: event.model, effort: event.effort, skills: event.skills }; sessionId = event.sessionId }
        }), redact)
        result.sessionId ??= sessionId
        result.usage ??= { inputTokens: estimateTokens(req.prompt + (req.systemAppend ?? '')), outputTokens: estimateTokens(result.finalText) }
        if (!result.ok) failure = new Error(`只读调用失败：${result.error ?? result.finalText}；请检查 harness 后重试`)
      } catch (error) { failure = error }
      const end: InvocationEnd = { id: start.id, outcome: failure ? 'error' : 'ok', error: failure ? redact(String(failure)) : undefined,
        reported: redactValue(reported, redact), usage: result?.usage, sessionId: result?.sessionId, durationMs: Date.now() - began }
      await audit('invocation.finished', end)
      invocation = mergeInvocation(start, end)
      input.onInvocation?.(invocation)
      if (failure) throw Object.assign(new Error(redact(failure instanceof Error ? failure.message : String(failure))), { invocationId: start.id, repair })
      return result!
    }
    const emit = async <T extends EventType>(type: T, data: EventPayloads[T]) => {
      if (input.runId) await deps.stores.events.append(input.runId, { type, data, nodeId: input.role,
        actor: { type: 'agent', role: input.profile.role, harness: harness.id, invocationId: invocation?.id } })
    }
    try {
      const result = input.schema ? await runStructured(harness, request, input.schema, { repairs: deps.stores.config.output?.repairs, validate: input.validate, invoke,
        onInvalid: event => emit('output.invalid', event), onRepaired: event => emit('output.repaired', event) }) : await invoke(request)
      return { result, invocation: invocation!, isolation }
    } catch (error) {
      if (error instanceof FailureError) Object.assign(error, { invocationId: invocation?.id })
      throw error
    }
  } finally { try { await route?.close() } finally { await sandbox?.dispose() } }
}
