import { randomUUID } from 'node:crypto'
import type { HarnessAdapter, HarnessSelector, InvocationEnd, InvocationStart, Pairing } from '../types.js'
import type { CaptureContext } from './checkpoints.js'
import type { HarnessHost } from './harness.js'
import { loadedSkills } from './recipe.js'

export async function startInvocation(host: HarnessHost, nodeId: string, agentRole: string, harness: HarnessAdapter, requested: HarnessSelector,
  resolved: { model?: string; effort?: string; provider?: string; pairing?: Pairing }, fallbackIndex: number, cwd: string, context: CaptureContext, recipeKey?: string, repair?: number): Promise<InvocationStart> {
  const provided = await loadedSkills(cwd, harness.id)
  const value: InvocationStart = { id: randomUUID(), nodeId, attempt: host.state.nodes[nodeId]!.attempts,
    checkpointId: context.checkpointId, role: context.role, agentRole, fallbackIndex, recipeKey, harness: harness.id,
    provider: resolved.provider, pairing: resolved.pairing, repair,
    model: { requested: requested.model, resolved: resolved.model, applied: harness.capabilities?.modelOverride },
    effort: { requested: requested.effort, resolved: resolved.effort, applied: harness.capabilities?.effortOverride },
    skills: host.deps.profiles[agentRole]!.skills.map(name => ({ name, providedHash: provided.find(skill => skill.name === name)?.hash, confirmed: 'unknown' })),
    readOnly: context.snapshot || repair ? true : undefined, at: host.timestamp() }
  await host.emit('invocation.started', value, nodeId, { type: 'agent', role: agentRole, harness: harness.id, invocationId: value.id })
  return value
}
export function mergeInvocation(start: InvocationStart, end: InvocationEnd): InvocationStart & InvocationEnd {
  return { ...start, ...end, model: { ...start.model, reported: end.reported?.model }, effort: { ...start.effort, reported: end.reported?.effort },
    skills: start.skills.map(skill => ({ ...skill, confirmed: end.reported?.skills === undefined ? 'unknown' : end.reported.skills.includes(skill.name) ? 'yes' : 'no' })) }
}
